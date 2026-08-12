/** Gallery Mobile Queue - Google Apps Script web app */
const QUEUE_FILE_ID = '11Rn-CJXUoKUAMT0V9KMCmV7aTFHlpHRk';
const PRIVATE_TOKEN = 'BAyW42U2v4pLlFWSe6dAIj9mQgqYSqB99gweIuS07KgTOYKzkXFux2lqHxCT5SDX';
const QUEUE_LOCK_WAIT_MS = 1500;

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
  // Clients treat retry:true as transient. Failing fast is better than making
  // a mobile HTTP request sit inside waitLock(10000) until its own timeout.
  return json_({error:'Busy', retry:true});
}

function doGet(e) {
  if (!authorized_(e.parameter.token)) return json_({error:'Unauthorized'});
  if ((e.parameter.action || 'list') !== 'list') return json_({error:'Unsupported action'});

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
    return json_({error:'Invalid JSON'});
  }

  if (!authorized_(body.token)) return json_({error:'Unauthorized'});

  const action = String(body.action || '');
  let url = '';
  if (action === 'append') {
    url = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return json_({error:'Invalid URL'});
  } else if (action !== 'ack') {
    return json_({error:'Unsupported action'});
  }

  const lock = acquireQueueLock_();
  if (!lock) return busy_();

  try {
    const entries = readQueue_();

    if (action === 'append') {
      const duplicate = entries.some(entry => entry.url === url);
      if (!duplicate) {
        entries.push({id: Utilities.getUuid(), url, createdAt: new Date().toISOString()});
        writeQueue_(entries);
      }
      return json_({ok:true, duplicate});
    }

    const ids = new Set((body.ids || []).map(String));
    const remaining = entries.filter(entry => !ids.has(String(entry.id)));
    writeQueue_(remaining);
    return json_({ok:true, removed: entries.length - remaining.length});
  } finally {
    lock.releaseLock();
  }
}
