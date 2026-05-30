const Database = require('better-sqlite3');
const db = new Database('C:\\Users\\1104289\\AppData\\Roaming\\meetingminutes\\data\\meetingminutes.db');

try {
  console.log('--- ALL JOBS ---');
  const jobs = db.prepare('SELECT id, source_name, status, created_at FROM jobs').all();
  console.log(JSON.stringify(jobs, null, 2));

  console.log('--- SETTINGS ---');
  const settings = db.prepare('SELECT key, value FROM settings').all();
  console.log(JSON.stringify(settings, null, 2));

  console.log('--- SEARCHING FOR TARGET JOB ---');
  const targetJob = db.prepare("SELECT * FROM jobs WHERE source_name LIKE '%2026-05-29%' OR source_name LIKE '%1.m4a%'").all();
  if (targetJob.length > 0) {
    for (const job of targetJob) {
      console.log(`Job Found: ${job.id} - ${job.source_name}`);
      console.log(`Status: ${job.status}`);
      console.log(`Transcript Length: ${job.transcript_text.length}`);
      console.log(`Transcript Snippet:\n${job.transcript_text.slice(0, 500)}...\n`);
      console.log(`Summary JSON:\n${job.summary_json}\n`);
    }
  } else {
    console.log('No matching job found!');
  }

} catch (err) {
  console.error(err);
} finally {
  db.close();
}
