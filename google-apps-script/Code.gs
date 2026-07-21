/** Gallery Mobile Queue - Google Apps Script web app */
const QUEUE_FILE_ID = '11Rn-CJXUoKUAMT0V9KMCmV7aTFHlpHRk';
const PRIVATE_TOKEN = 'PASTE_A_LONG_RANDOM_TOKEN_HERE';

function json_(value, code) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
function authorized_(token) { return token && token === PRIVATE_TOKEN; }
function readQueue_() {
  const text = DriveApp.getFileById(QUEUE_FILE_ID).getBlob().getDataAsString('UTF-8').trim();
  if (!text) return [];
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
function writeQueue_(entries) {
  const text = entries.map(entry => JSON.stringify(entry)).join('\n');
  DriveApp.getFileById(QUEUE_FILE_ID).setContent(text ? text + '\n' : '');
}
function doGet(e) {
  if (!authorized_(e.parameter.token)) return json_({error:'Unauthorized'});
  if ((e.parameter.action || 'list') !== 'list') return json_({error:'Unsupported action'});
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try { return json_(readQueue_()); } finally { lock.releaseLock(); }
}
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (_) { return json_({error:'Invalid JSON'}); }
  if (!authorized_(body.token)) return json_({error:'Unauthorized'});
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const entries = readQueue_();
    if (body.action === 'append') {
      const url = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return json_({error:'Invalid URL'});
      if (!entries.some(entry => entry.url === url)) {
        entries.push({id: Utilities.getUuid(), url, createdAt: new Date().toISOString()});
        writeQueue_(entries);
      }
      return json_({ok:true});
    }
    if (body.action === 'ack') {
      const ids = new Set((body.ids || []).map(String));
      const remaining = entries.filter(entry => !ids.has(String(entry.id)));
      writeQueue_(remaining);
      return json_({ok:true, removed: entries.length - remaining.length});
    }
    return json_({error:'Unsupported action'});
  } finally { lock.releaseLock(); }
}
