import sqlite3
import json

db_path = r'C:\Users\1104289\AppData\Roaming\meetingminutes\data\meetingminutes.db'

try:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    print('--- ALL JOBS ---')
    cursor.execute('SELECT id, source_name, status, created_at FROM jobs')
    jobs = [dict(row) for row in cursor.fetchall()]
    print(json.dumps(jobs, indent=2, ensure_ascii=False))

    print('--- SETTINGS ---')
    cursor.execute('SELECT key, value FROM settings')
    settings = [dict(row) for row in cursor.fetchall()]
    print(json.dumps(settings, indent=2, ensure_ascii=False))

    print('--- SEARCHING FOR TARGET JOB ---')
    cursor.execute("SELECT * FROM jobs WHERE source_name LIKE '%2026-05-29%' OR source_name LIKE '%1.m4a%'")
    target_jobs = [dict(row) for row in cursor.fetchall()]
    if target_jobs:
        for job in target_jobs:
            print(f"Job Found: {job['id']} - {job['source_name']}")
            print(f"Status: {job['status']}")
            print(f"Transcript Length: {len(job['transcript_text'])}")
            print(f"Transcript Snippet:\n{job['transcript_text'][:500]}...\n")
            print(f"Summary JSON:\n{job['summary_json']}\n")
    else:
        print('No matching job found!')

except Exception as e:
    print('Error:', e)
finally:
    if 'conn' in locals():
        conn.close()
