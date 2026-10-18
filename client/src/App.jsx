import { useState, useEffect } from 'react';

const api = async (path, body, pin) => {
  const r = await fetch('/api/' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(pin ? { 'x-pin': pin } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
};
const AGES = [['', 'Not sure'], ['child', 'Child (under 13)'], ['teen', 'Teen (13 to 17)'], ['adult', 'Adult'], ['senior', 'Older adult (65+)']];
const Field = ({ label, hint, children }) => <label className="field"><span>{label}</span>{hint && <small>{hint}</small>}{children}</label>;
const AgeSelect = ({ value, onChange }) => <select value={value} onChange={onChange}>{AGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;

function Search() {
  const [q, setQ] = useState({ name: '', ageRange: '', code: '' });
  const [results, setResults] = useState(null);
  const [note, setNote] = useState({ contact: '', message: '' });
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setQ({ ...q, [k]: e.target.value });
  const search = async (e) => { e.preventDefault(); setErr(''); setSent(false); try { setResults((await api('search', q)).results); } catch (x) { setErr(x.message); } };
  const send = async (e) => { e.preventDefault(); setErr(''); try { await api('notes', { query: q, ...note }); setSent(true); } catch (x) { setErr(x.message); } };
  return (
    <section>
      <h2>Find someone</h2>
      <form onSubmit={search}>
        <Field label="Their name, or what they go by"><input value={q.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Age group" hint="Optional"><AgeSelect value={q.ageRange} onChange={set('ageRange')} /></Field>
        <Field label="Shelter code" hint="If they gave you one, like RIV-1234"><input value={q.code} onChange={set('code')} /></Field>
        <button className="primary">Search</button>
      </form>
      {err && <p className="error" role="alert">{err}</p>}
      {results && (
        <div className="results">
          {results.length ? results.map((r) => <div className="card" key={r.code}><strong>{r.displayName}</strong><span>{r.shelterName}, code {r.code}</span></div>) : <p>No public match yet.</p>}
          <h3>Leave a note for shelter staff</h3>
          <p>Not everyone chooses to be listed. If staff at any shelter meet someone who may be them, they will ask that person first and pass your note on only if they agree.</p>
          {sent ? <p className="ok">Note saved. Search again later, or ask a volunteer at your shelter.</p> : (
            <form onSubmit={send}>
              <Field label="How can staff reach you?" hint="Shelter you are at, or a phone number"><input value={note.contact} onChange={(e) => setNote({ ...note, contact: e.target.value })} required /></Field>
              <Field label="Message" hint="Optional"><textarea rows="3" value={note.message} onChange={(e) => setNote({ ...note, message: e.target.value })} /></Field>
              <button className="primary">Save note</button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}

const blank = { name: '', alias: '', ageRange: '', travelingWith: '', lastSeen: '', visibility: 'ask' };
const VIS = [
  ['ask', 'Ask me first', 'Searchers see nothing. Staff ask me before anyone is told where I am.'],
  ['open', 'List me', 'Anyone searching my name sees which shelter I am at.'],
  ['hidden', 'Keep me private', 'No one is told, even if someone is looking for me.'],
];
function CheckIn({ pin }) {
  const [f, setF] = useState(blank);
  const [done, setDone] = useState(null);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const minor = f.ageRange === 'child' || f.ageRange === 'teen';
  const submit = async (e) => { e.preventDefault(); setErr(''); try { setDone(await api('people', f, pin)); setF(blank); } catch (x) { setErr(x.message); } };
  if (done) return (
    <div className="card done">
      <p>Give this code to the person. It works as their ID here.</p>
      <p className="code">{done.code}</p>
      <p>{done.visibility === 'open' ? 'Listed in public search.' : done.visibility === 'ask' ? 'Not in search. Staff will ask before sharing.' : 'Not shared with anyone.'}</p>
      <button className="primary" onClick={() => setDone(null)}>Check in next person</button>
    </div>
  );
  return (
    <form onSubmit={submit}>
      <p className="hint">Every field is optional. Use whatever the person is comfortable sharing.</p>
      <Field label="Name"><input value={f.name} onChange={set('name')} autoFocus /></Field>
      <Field label="Or what they go by" hint="A nickname or first name only is fine"><input value={f.alias} onChange={set('alias')} /></Field>
      <Field label="Age group"><AgeSelect value={f.ageRange} onChange={set('ageRange')} /></Field>
      <Field label="Traveling with"><input value={f.travelingWith} onChange={set('travelingWith')} /></Field>
      <Field label="Last place they were"><input value={f.lastSeen} onChange={set('lastSeen')} /></Field>
      <fieldset>
        <legend>Who can find this person? Read these out loud.</legend>
        {minor ? <p className="hint">Children and teens are always "Ask me first".</p> : VIS.map(([v, t, d]) => (
          <label className="radio" key={v}><input type="radio" name="vis" checked={f.visibility === v} onChange={() => setF({ ...f, visibility: v })} /><span><strong>{t}</strong><small>{d}</small></span></label>
        ))}
      </fieldset>
      {err && <p className="error" role="alert">{err}</p>}
      <button className="primary">Check in</button>
    </form>
  );
}

function Inbox({ pin }) {
  const [notes, setNotes] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api('staff/notes', null, pin).then((d) => setNotes(d.notes)).catch((x) => setErr(x.message));
  useEffect(() => { load(); }, []);
  const finish = async (id) => { await api('staff/notes/' + id + '/resolve', {}, pin); load(); };
  if (err) return <p className="error">{err}</p>;
  if (!notes) return <p>Loading</p>;
  return (
    <div>
      <p className="hint">Someone is looking for a person registered here. Ask the person first. Only share the note if they say yes.</p>
      {!notes.length && <p>No notes for this shelter.</p>}
      {notes.map((n) => (
        <div className="card" key={n.id}>
          <strong>Looking for: {n.searchedFor}</strong>
          <span>Reach them at: {n.contact}</span>
          {n.message && <span>"{n.message}"</span>}
          {n.people.map((p) => <span key={p.code}>Possible match: {p.name || p.alias} ({p.code}, {p.visibility === 'open' ? 'listed' : 'ask first'})</span>)}
          <button onClick={() => finish(n.id)}>Mark done</button>
        </div>
      ))}
      <button onClick={load}>Refresh</button>
    </div>
  );
}

function Staff() {
  const [pin, setPin] = useState('');
  const [shelter, setShelter] = useState(null);
  const [view, setView] = useState('checkin');
  const [err, setErr] = useState('');
  const login = async (e) => { e.preventDefault(); try { setShelter((await api('staff/me', null, pin)).name); setErr(''); } catch (x) { setErr(x.message); } };
  if (!shelter) return (
    <section>
      <h2>Shelter staff</h2>
      <form onSubmit={login}>
        <Field label="Shelter PIN" hint="Demo PINs: 1111, 2222, 3333"><input inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} /></Field>
        <button className="primary">Sign in</button>
      </form>
      {err && <p className="error" role="alert">{err}</p>}
    </section>
  );
  return (
    <section>
      <h2>{shelter}</h2>
      <div className="tabs">
        <button aria-pressed={view === 'checkin'} onClick={() => setView('checkin')}>Check someone in</button>
        <button aria-pressed={view === 'inbox'} onClick={() => setView('inbox')}>Notes from searchers</button>
      </div>
      {view === 'checkin' ? <CheckIn pin={pin} /> : <Inbox pin={pin} />}
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState('find');
  return (
    <main>
      <header>
        <h1>Family Finder</h1>
        <div className="tabs">
          <button aria-pressed={tab === 'find'} onClick={() => setTab('find')}>Find someone</button>
          <button aria-pressed={tab === 'staff'} onClick={() => setTab('staff')}>Shelter staff</button>
        </div>
      </header>
      {tab === 'find' ? <Search /> : <Staff />}
    </main>
  );
}
