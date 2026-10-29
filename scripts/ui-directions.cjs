// Original static design studies. Asset-only, hidden, no network or app IPC.
const { app, BrowserWindow, session } = require('electron')
const { writeFileSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const scratch = mkdtempSync('/tmp/nimbo-directions-')
app.setPath('userData', scratch)
setTimeout(() => app.exit(1), 20000).unref()
app.whenReady().then(async () => {
  app.dock?.hide()
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !d.url.startsWith('file:') }))
  const output = '/tmp/nimbo-ui-directions'; mkdirSync(output, { recursive: true })
  const win = new BrowserWindow({ width: 960, height: 680, show: false, paintWhenInitiallyHidden: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const text = (x,y,value,size=13,fill='#626262',weight=400) => `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}">${value}</text>`
  const rect = (x,y,w,h,fill,r=6) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" rx="${r}"/>`
  const drawing = (x,y,w,h,accent) => `${rect(x,y,w,h,'#EEEEEE',10)}<g transform="translate(${x+24} ${y+24})"><rect x="100" y="0" width="140" height="38" rx="3" fill="none" stroke="${accent}" stroke-width="2"/><path d="M20 95Q60 70 116 37m-12 1 14-3-5 13" fill="none" stroke="${accent}" stroke-width="2"/>${text(4,124,'Export your chart',18,accent)}</g>`
  for (const [name,accent] of [['pen-margin','#70415F'],['signal-desk','#315B97'],['field-notes','#536344']]) {
    let body = ''
    if (name === 'pen-margin') {
      body = `${rect(0,0,240,680,'#EEEEEE',0)}${text(24,68,'Conversations',15,'#626262',500)}${rect(16,88,208,32,'#F8F8F8')}${text(28,109,'Search conversations…')}${text(26,151,'＋  New conversation',13,'#282828',500)}${text(24,210,'Pinned',12)}${rect(12,224,216,64,'#DEDEDE')}${rect(12,236,3,40,accent,0)}${text(24,247,'Where can I export this…',13,'#282828',500)}${text(24,271,'Choose Export in the upper-right…',12)}${text(24,326,'Today',12)}${text(24,360,'Explain this warning',13,'#282828',500)}${text(24,383,'The file has unsaved changes.',12)}${text(24,650,'Settings',13)}${text(280,40,'Where can I export this chart?',13,'#626262',500)}${text(288,116,'Where can I export this chart?',20,'#282828',600)}${text(288,143,'Voice at 13:49. Screen used, not saved.',12)}${text(288,192,'Choose Export in the upper-right corner.',17,'#282828')}${text(288,219,'Then choose PDF from the download menu.',17,'#282828')}${rect(288,250,3,176,accent,0)}${drawing(303,250,320,176,accent)}${text(303,449,'Drawing by NimboGuide. No screen image saved.',12)}${rect(288,540,624,88,'#FFFFFF',14)}${text(304,568,'Ask about your screen…',15)}${text(304,608,'Screen shared for this question',12)}${rect(860,576,44,44,accent)}${text(875,603,'↑',22,'#FFFFFF')}${text(288,653,'Hold Control + Option to speak',12)}${text(732,653,'Saved locally · 30 days',12)}`
    } else if (name === 'signal-desk') {
      body = `${rect(0,0,960,64,'#FFFFFF',0)}${text(28,39,'NimboGuide',17,'#282828',600)}${text(218,38,'Search conversations…')}${rect(788,14,144,40,accent)}${text(804,39,'New conversation',13,'#FFFFFF')}${rect(0,64,960,86,'#EEEEEE',0)}${rect(20,78,280,58,'#FFFFFF')}${text(34,101,'Where can I export this chart?',13,accent,600)}${text(34,122,'Pinned · 13:49',12)}${text(330,101,'Explain this warning',13,'#282828',500)}${text(330,123,'Today · 13:46',12)}${text(48,209,'Where can I export this chart?',24,'#282828',500)}${text(48,241,'Voice at 13:49. Screen used, not saved.',12)}${text(48,294,'Choose Export in the upper-right corner.',17,'#282828')}${text(48,323,'The download menu lets you save a PDF.',17,'#282828')}${drawing(544,267,360,188,accent)}${text(568,478,'Generated drawing. No screen image saved.',12)}${rect(48,542,864,74,'#EEEEEE',6)}${text(68,574,'Ask a follow-up about your screen…',15)}${rect(796,554,104,50,accent)}${text(818,584,'Ask   ↑',15,'#FFFFFF')}${text(48,649,'Control + Option for voice',12)}${text(840,649,'Settings',13)}`
    } else {
      body = `${rect(0,0,72,680,'#536344',0)}${text(24,43,'N',24,'#FFFFFF',600)}${text(22,122,'＋',24,'#FFFFFF')}<g fill="none" stroke="#FFFFFF" stroke-width="2"><circle cx="36" cy="610" r="7"/><path d="M36 598v5m0 14v5m-12-12h5m14 0h5"/></g>${rect(72,0,224,680,'#EEEEEE',0)}${text(96,70,'Your notes',20,'#282828',500)}${text(96,111,'Search…')}${text(96,169,'Pinned',12)}${rect(84,182,200,94,'#FFFFFF',10)}${text(96,210,'Where can I export',14,'#282828',500)}${text(96,232,'this chart?',14,'#282828',500)}${text(96,257,'Today, 13:49',12)}${text(96,319,'Explain this warning',13,'#282828',500)}${text(328,71,'Where can I export this chart?',20,'#282828',500)}${text(328,106,'Voice at 13:49. Screen used, not saved.',12)}${text(328,170,'Choose Export in the',17,'#282828')}${text(328,198,'upper-right corner.',17,'#282828')}${text(328,238,'The download menu',17,'#282828')}${text(328,266,'lets you save a PDF.',17,'#282828')}${drawing(584,153,344,190,accent)}${text(608,367,'NimboGuide drew this',12)}${rect(328,538,600,90,'#FFFFFF',10)}${text(344,568,'Ask about your screen…',15)}${text(344,607,'Screen shared for this question',12)}${rect(876,576,44,44,accent)}${text(891,603,'↑',22,'#FFFFFF')}${text(328,654,'Hold Control + Option to speak',12)}`
    }
    const page = join(scratch, 'study.html')
    writeFileSync(page, `<html><body style="margin:0;background:#F8F8F8"><svg xmlns="http://www.w3.org/2000/svg" width="960" height="680" style="font-family:-apple-system,BlinkMacSystemFont,sans-serif">${body}</svg></body></html>`)
    await win.loadFile(page)
    await new Promise(r => setTimeout(r,100))
    writeFileSync(`${output}/${name}.png`, (await win.webContents.capturePage()).toPNG())
  }
  win.destroy(); app.quit()
}).catch(e => { console.error(e); app.exit(1) })
app.on('will-quit', () => rmSync(scratch, { recursive:true,force:true }))
