import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { GoogleAuth } from 'google-auth-library';

initializeApp();
const db = getFirestore();
const resendApiKey = defineSecret('RESEND_API_KEY');
const adminEmails = defineSecret('ADMIN_EMAILS');
const mailFrom = defineSecret('MAIL_FROM');
const googleSheetId = defineSecret('GOOGLE_SHEET_ID');

const validDate = /^\d{4}-\d{2}-\d{2}$/;

export const createBooking = onCall({ secrets: [resendApiKey, adminEmails, mailFrom] }, async (request) => {
  const { name, email, session, notes = '', date } = request.data || {};
  if (!name?.trim() || name.length > 120 || !email?.includes('@') || email.length > 254 || !session?.trim() || session.length > 120 || notes.length > 3000 || !validDate.test(date || '')) {
    throw new HttpsError('invalid-argument', 'Please provide a name, email, session, and valid date.');
  }
  if (date < new Date().toISOString().slice(0, 10)) throw new HttpsError('invalid-argument', 'Choose a future date.');

  const dateRef = db.collection('availability').doc(date);
  const bookingRef = db.collection('bookings').doc();
  await db.runTransaction(async (transaction) => {
    const availability = await transaction.get(dateRef);
    if (availability.exists && ['booked', 'held'].includes(availability.data().status)) {
      throw new HttpsError('already-exists', 'That date is no longer available.');
    }
    transaction.set(bookingRef, { name: name.trim(), email: email.trim(), session: session.trim(), notes: notes.trim(), date, status: 'pending', createdAt: FieldValue.serverTimestamp() });
    transaction.set(dateRef, { status: 'held', bookingId: bookingRef.id, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });

  const recipients = adminEmails.value().split(',').map((value) => value.trim()).filter(Boolean);
  if (recipients.length && resendApiKey.value() && mailFrom.value()) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendApiKey.value()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: mailFrom.value(), to: recipients, reply_to: email.trim(), subject: `New booking request: ${date}`, text: `Name: ${name}\nEmail: ${email}\nSession: ${session}\nDate: ${date}\nNotes: ${notes || 'None'}` })
    });
    if (!response.ok) console.error('Booking email could not be sent', await response.text());
  }

  return { id: bookingRef.id, status: 'pending' };
});

const acceptedSheetTitle = 'Accepted Bookings';
const acceptedSheetHeaders = [
  'Booking ID', 'Confirmed At', 'Session Date', 'Client Name', 'Email',
  'Session Type', 'Notes', 'Status', 'Confirmed By'
];

async function sheetsRequest(accessToken, path, options = {}) {
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...options.headers }
  });
  if (!response.ok) throw new Error(`Google Sheets API ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function getAcceptedBookingsSheet(accessToken, spreadsheetId) {
  const spreadsheet = await sheetsRequest(accessToken, `${spreadsheetId}?fields=sheets.properties`);
  const existing = spreadsheet.sheets?.find((sheet) => sheet.properties?.title === acceptedSheetTitle);
  if (!existing) {
    await sheetsRequest(accessToken, `${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          addSheet: {
            properties: { title: acceptedSheetTitle, gridProperties: { frozenRowCount: 1 } }
          }
        }]
      })
    });
  }

  const headerRange = `'${acceptedSheetTitle}'!A1:I1`;
  const header = await sheetsRequest(accessToken, `${spreadsheetId}/values/${encodeURIComponent(headerRange)}`);
  if (!header.values?.length) {
    await sheetsRequest(accessToken, `${spreadsheetId}/values/${encodeURIComponent(headerRange)}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [acceptedSheetHeaders] })
    });
  }
}

export const confirmBooking = onCall({ secrets: [googleSheetId] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Administrator sign-in required.');
  const admin = await db.collection('admins').doc(request.auth.uid).get();
  if (!admin.exists) throw new HttpsError('permission-denied', 'Administrator access required.');

  const bookingId = String(request.data?.bookingId || '').trim();
  if (!bookingId) throw new HttpsError('invalid-argument', 'A booking ID is required.');

  const spreadsheetId = googleSheetId.value().trim();
  if (!spreadsheetId) throw new HttpsError('failed-precondition', 'Google Sheets has not been connected yet.');

  const bookingRef = db.collection('bookings').doc(bookingId);
  const bookingSnapshot = await bookingRef.get();
  if (!bookingSnapshot.exists) throw new HttpsError('not-found', 'Booking request not found.');

  const booking = bookingSnapshot.data();
  if (booking.status === 'confirmed' && booking.sheetSyncedAt) {
    return { status: 'confirmed', synced: true };
  }

  try {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const client = await auth.getClient();
    const tokenResult = await client.getAccessToken();
    const accessToken = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
    if (!accessToken) throw new Error('Could not obtain a Google access token.');
    await getAcceptedBookingsSheet(accessToken, spreadsheetId);
    const confirmedAt = new Date().toISOString();

    const appendRange = `'${acceptedSheetTitle}'!A:I`;
    await sheetsRequest(accessToken, `${spreadsheetId}/values/${encodeURIComponent(appendRange)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({
        values: [[
          bookingId,
          confirmedAt,
          booking.date || '',
          booking.name || '',
          booking.email || '',
          booking.session || '',
          booking.notes || '',
          'Confirmed',
          request.auth.token.email || request.auth.uid
        ]]
      })
    });

    await db.runTransaction(async (transaction) => {
      const latest = await transaction.get(bookingRef);
      if (!latest.exists) throw new HttpsError('not-found', 'Booking request not found.');
      transaction.update(bookingRef, {
        status: 'confirmed',
        confirmedAt: FieldValue.serverTimestamp(),
        confirmedBy: request.auth.uid,
        sheetSyncedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      transaction.set(db.collection('availability').doc(booking.date), {
        status: 'booked', bookingId, updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });

    return { status: 'confirmed', synced: true };
  } catch (error) {
    console.error('Could not sync confirmed booking to Google Sheets', error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'The booking was not confirmed because Google Sheets could not be updated. Check the sheet sharing settings and try again.');
  }
});
