"""Audit report links against retained, successfully fetched evidence."""
import hashlib, json, pathlib, re, subprocess, urllib.parse
ROOT = pathlib.Path(__file__).parent
manifest = json.loads((ROOT/'harness-sources.json').read_text())
report = (ROOT.parent/'02-harness-options.md').read_text()
def normalize(url):
    return re.sub(r'\.md$', '', url.rstrip('/'))
by_url = {normalize(r['url']):r for r in manifest if r['ok']}
links = sorted(set(re.findall(r'\]\((https?://[^)]+)\)',report)))
audit=[]
for url in links:
    canonical=url
    if 'github.com/' in url and '/blob/' in url:
        canonical=url.replace('github.com/','raw.githubusercontent.com/').replace('/blob/','/')
    evidence=by_url.get(normalize(canonical))
    method='fetched-url'
    if not evidence and '/commit/' in url:
        sha=url.rsplit('/',1)[1]
        evidence=next((r for r in manifest if r['ok'] and r['name'].endswith('-meta.json') and json.loads(pathlib.Path(r['path']).read_text()).get('sha')==sha),None)
        method='fetched-commit-metadata'
    if not evidence and 'raw.githubusercontent.com/' in canonical:
        parts=urllib.parse.urlparse(canonical).path.strip('/').split('/')
        repository='/'.join(parts[:2]); revision=parts[2]; rel='/'.join(parts[3:])
        for treefile in (ROOT/'harness-evidence').glob('harness-*-tree.json'):
            tree=json.loads(treefile.read_text())
            if tree.get('sha')!=revision: continue
            blob=next((t for t in tree['tree'] if t['path']==rel),None)
            if blob:
                evidence=next((r for r in manifest if r['ok'] and r['url'].endswith('/git/blobs/'+blob['sha'])),None)
                if evidence: method='pinned-blob-api-recovery'; break
    audit.append({'url':url,'ok':bool(evidence),'method':method,'evidence_path':evidence.get('path') if evidence else None})
for r in manifest:
    if r['ok']:
        data=pathlib.Path(r['path']).read_bytes()
        assert hashlib.sha256(data).hexdigest()==r['sha256'],r['path']
assert 250<=len(report.splitlines())<=350,len(report.splitlines())
missing=[x for x in audit if not x['ok']]
result={'lines':len(report.splitlines()),'unique_external_links':len(links),'missing_evidence':missing,'audit':audit,'probe':json.loads((ROOT/'harness-ai-probe-result.json').read_text())['checks']}
(ROOT/'harness-link-audit.json').write_text(json.dumps(result,indent=2))
print(json.dumps({k:v for k,v in result.items() if k!='audit'},indent=2))
assert not missing,missing
ledger=ROOT/'harness-citations.json'
tool=pathlib.Path.home()/'.hermes/skills/research/grounded-citations/scripts/sources.py'
p=subprocess.run(['python3',str(tool),'--ledger',str(ledger),'add',*[r['url'] for r in manifest if r['ok']]],capture_output=True,text=True)
print('citation_ledger_exit',p.returncode)
if p.returncode: print(p.stdout,p.stderr)
assert p.returncode==0
