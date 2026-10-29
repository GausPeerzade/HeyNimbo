"""Read-only public-source retrieval; writes only harness-* evidence."""
import concurrent.futures, datetime, hashlib, json, pathlib, subprocess, sys
ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / 'harness-evidence'
OUT.mkdir(exist_ok=True, parents=True)
MANIFEST = ROOT / 'harness-sources.json'
def fetch(item):
    name, url = item
    target = OUT / ('harness-' + name)
    p = subprocess.run(['curl','-fLsS','--retry','1','--max-time','90','-A','HeyNimbo-harness-research',url], capture_output=True)
    record = {'name':name,'url':url,'retrieved_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'ok':p.returncode == 0,'error':p.stderr.decode(errors='replace')}
    if not p.returncode:
        target.write_bytes(p.stdout)
        record.update(path=str(target),bytes=len(p.stdout),sha256=hashlib.sha256(p.stdout).hexdigest())
    return record
if __name__ == '__main__':
    items = json.loads(pathlib.Path(sys.argv[1]).read_text())
    old = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else []
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        records = list(pool.map(fetch,items))
    by_url = {r['url']:r for r in old}
    by_url.update({r['url']:r for r in records})
    MANIFEST.write_text(json.dumps(list(by_url.values()),indent=2))
    for r in records: print(json.dumps(r))
