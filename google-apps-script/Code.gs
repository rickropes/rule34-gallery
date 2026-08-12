/** Gallery Mobile Queue - Google Apps Script web app */
const QUEUE_FILE_ID = '11Rn-CJXUoKUAMT0V9KMCmV7aTFHlpHRk';
const PRIVATE_TOKEN = 'BAyW42U2v4pLlFWSe6dAIj9mQgqYSqB99gweIuS07KgTOYKzkXFux2lqHxCT5SDX';
const QUEUE_LOCK_WAIT_MS = 1500;
const APPEND_LOCK_WAIT_MS = 8000;

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function authorized_(token) {
  return token && token === PRIVATE_TOKEN;
}

function readQueue_() {
  const text = DriveApp.getFileById(QUEUE_FILE_ID).getBlob().getDataAsString('UTF-8').trim();
  if (!text) return [];
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function writeQueue_(entries) {
  const text = entries.map(entry => JSON.stringify(entry)).join('\n');
  DriveApp.getFileById(QUEUE_FILE_ID).setContent(text ? text + '\n' : '');
}

function acquireQueueLock_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(QUEUE_LOCK_WAIT_MS)) return null;
  return lock;
}

function busy_() {
  return json_({error:'Busy', retry:true});
}

/**
 * Mobile append protocol v2.
 *
 * ContentService always redirects a successful TextOutput response to a
 * one-time script.googleusercontent.com URL. The Android client intentionally
 * treats the INITIAL redirect from script.google.com as the append receipt and
 * does not fetch that one-time URL. Therefore this function must only return a
 * TextOutput after the append has definitely completed.
 *
 * Errors throw instead of returning TextOutput, so an auth/validation/Drive/
 * lock failure cannot be mistaken by Android for a successful append receipt.
 */
function appendAndReturnReceipt_(body) {
  if (!authorized_(body.token)) throw new Error('Unauthorized');

  const url = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Invalid URL');

  const lock = LockService.getScriptLock();
  lock.waitLock(APPEND_LOCK_WAIT_MS);
  try {
    const entries = readQueue_();
    const duplicate = entries.some(entry => entry.url === url);
    if (!duplicate) {
      entries.push({id: Utilities.getUuid(), url, createdAt: new Date().toISOString()});
      writeQueue_(entries);
    }
    // Reaching this return means the queue already contains the URL.
    return json_({ok:true, duplicate, protocol:2});
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  if (!authorized_(e.parameter.token)) return json_({error:'Unauthorized'});
  const action = e.parameter.action || 'list';
  if (action === 'capabilities') {
    return json_({ok:true, appendReceipt:2});
  }
  if (action !== 'list') return json_({error:'Unsupported action'});

  const lock = acquireQueueLock_();
  if (!lock) return busy_();
  try {
    return json_(readQueue_());
  } finally {
    lock.releaseLock();
  }
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents || '{}');
  } catch (_) {
    throw new Error('Invalid JSON');
  }

  const action = String(body.action || '');

  // Important: append uses the v2 receipt semantics above. Do not convert its
  // errors back into ContentService JSON responses or Android could interpret
  // the redirect as success.
  if (action === 'append') {
    return appendAndReturnReceipt_(body);
  }

  if (!authorized_(body.token)) return json_({error:'Unauthorized'});
  if (action !== 'ack') return json_({error:'Unsupported action'});

  const lock = acquireQueueLock_();
  if (!lock) return busy_();

  try {
    const entries = readQueue_();
    const ids = new Set((body.ids || []).map(String));
    const remaining = entries.filter(entry => !ids.has(String(entry.id)));
    writeQueue_(remaining);
    return json_({ok:true, removed: entries.length - remaining.length});
  } finally {
    lock.releaseLock();
  }
}
