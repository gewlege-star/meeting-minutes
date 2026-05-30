const Database = require('better-sqlite3')
const fs = require('fs')
const db = new Database(
  'C:\\Users\\1104289\\AppData\\Roaming\\meetingminutes\\data\\meetingminutes.db'
)

try {
  let output = ''

  // Get job details
  const jobId = 'c1ae4cb2-7e10-4eab-982d-3e5078aeb3a7'
  const jobRow = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId)
  if (jobRow) {
    output += `# Job: ${jobRow.source_name}\n`
    output += `Job ID: ${jobRow.id}\n`
    output += `Status: ${jobRow.status}\n\n`
    output += `## Raw Transcript Text\n\`\`\`\n${jobRow.transcript_text}\n\`\`\`\n\n`
  } else {
    output += `Job row for ID ${jobId} not found\n\n`
  }

  // Get custom tabs and prompt
  const row = db.prepare("SELECT value FROM settings WHERE key = 'customTabs'").get()
  let targetTabId = ''
  if (row) {
    const tabs = JSON.parse(row.value)
    const target = tabs.find((t) => t.name.includes('Adaptive') || t.name.includes('Adptive'))
    if (target) {
      targetTabId = target.id
      output += `## Adaptive Summary Tab Info\n`
      output += `- ID: ${target.id}\n`
      output += `- Name: ${target.name}\n\n`
      output += `### Tab Prompt Template:\n\`\`\`text\n${target.prompt}\n\`\`\`\n\n`
    } else {
      output += `Adaptive tab not found. List of tabs:\n`
      tabs.forEach((t) => {
        output += `- ${t.name} (ID: ${t.id})\n`
      })
      output += `\n`
    }
  } else {
    output += `customTabs settings row not found\n\n`
  }

  // Get Custom Tab Results
  const resultsRow = db.prepare("SELECT value FROM settings WHERE key = 'customTabResults'").get()
  if (resultsRow) {
    const results = JSON.parse(resultsRow.value)
    output += `## Custom Tab Results\n`
    const resultKey = `${jobId}-${targetTabId}`
    if (targetTabId && results[resultKey]) {
      output += `### Result for key: ${resultKey}\n\`\`\`text\n${results[resultKey]}\n\`\`\`\n\n`
    } else {
      output += `No result found for key: ${resultKey}. Keys present:\n`
      Object.keys(results).forEach((k) => {
        if (k.startsWith(jobId)) {
          output += `- ${k} (Value length: ${results[k].length} chars)\n`
        }
      })
      output += `\n`
    }
  } else {
    output += `customTabResults settings row not found\n\n`
  }

  fs.writeFileSync('prompt_output.md', output, 'utf8')
  console.log('Successfully wrote diagnostic info to prompt_output.md')
} catch (err) {
  console.error(err)
} finally {
  db.close()
  process.exit(0)
}
