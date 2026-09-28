// Storage layer. Same async interface for both backends:
//   insert(coll, doc) · update(coll, id, patch) · get(coll, id) · list(coll, {filter, sort, limit}) · count(coll, filter)
// Default: a JSON file (zero installs). Set MONGODB_URI to use MongoDB instead.
const fs = require("fs");
const path = require("path");

const COLLECTIONS = ["sewers", "readings", "alerts", "inspections", "robot_events", "maintenance", "chain_records", "notifications"];
const READINGS_PER_SEWER = 300;   // keep the file small; history beyond this belongs in a real DB

const matches = (doc, filter = {}) => Object.entries(filter).every(([k, v]) => doc[k] === v);
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

function sortDocs(docs, sort) {
  if (!sort) return docs;
  const [[field, dir]] = Object.entries(sort);
  return [...docs].sort((a, b) => (a[field] < b[field] ? -dir : a[field] > b[field] ? dir : 0));
}

class FileStore {
  constructor(file) {           // file = null → memory only (tests)
    this.file = file;
    this.kind = file ? "file" : "memory";
    this.data = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
    this._timer = null;
  }
  async init() {
    if (this.file && fs.existsSync(this.file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
        for (const c of COLLECTIONS) this.data[c] = Array.isArray(saved[c]) ? saved[c] : [];
      } catch (e) {
        const bad = this.file + ".corrupt-" + Date.now();
        fs.renameSync(this.file, bad);
        console.warn(`[db] ${this.file} was unreadable; moved to ${bad} and started fresh`);
      }
    }
    return this;
  }
  _save() {
    if (!this.file) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 250);
  }
  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);                       // atomic replace
  }
  async insert(coll, doc) {
    this.data[coll].push(clone(doc));
    if (coll === "readings") {
      const mine = this.data.readings.filter((r) => r.sewer_id === doc.sewer_id);
      if (mine.length > READINGS_PER_SEWER) {
        const drop = new Set(mine.slice(0, mine.length - READINGS_PER_SEWER));
        this.data.readings = this.data.readings.filter((r) => !drop.has(r));
      }
    }
    this._save();
    return clone(doc);
  }
  async update(coll, id, patch) {
    const d = this.data[coll].find((x) => x.id === id);
    if (!d) return null;
    Object.assign(d, clone(patch));
    this._save();
    return clone(d);
  }
  async upsert(coll, doc) {
    return (await this.get(coll, doc.id)) ? this.update(coll, doc.id, doc) : this.insert(coll, doc);
  }
  async get(coll, id) { return clone(this.data[coll].find((x) => x.id === id) || null); }
  async list(coll, { filter, sort, limit } = {}) {
    let docs = this.data[coll].filter((d) => matches(d, filter));
    docs = sortDocs(docs, sort);
    return clone(limit ? docs.slice(0, limit) : docs);
  }
  async count(coll, filter) { return this.data[coll].filter((d) => matches(d, filter)).length; }
  async close() { clearTimeout(this._timer); this.flush(); }
}

class MongoStore {
  constructor(uri) { this.uri = uri; this.kind = "mongodb"; }
  async init() {
    const { MongoClient } = require("mongodb");
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 5000 });
    await this.client.connect();
    this.db = this.client.db();                      // database name comes from the URI
    for (const c of COLLECTIONS) await this.db.collection(c).createIndex({ id: 1 }, { unique: true });
    await this.db.collection("readings").createIndex({ sewer_id: 1, timestamp: -1 });
    return this;
  }
  _c(coll) { return this.db.collection(coll); }
  async insert(coll, doc) { await this._c(coll).insertOne(clone(doc)); return clone(doc); }
  async update(coll, id, patch) {
    const r = await this._c(coll).findOneAndUpdate({ id }, { $set: clone(patch) }, { returnDocument: "after", projection: { _id: 0 } });
    return r && (r.value !== undefined ? r.value : r);
  }
  async upsert(coll, doc) {
    await this._c(coll).updateOne({ id: doc.id }, { $set: clone(doc) }, { upsert: true });
    return this.get(coll, doc.id);
  }
  async get(coll, id) { return this._c(coll).findOne({ id }, { projection: { _id: 0 } }); }
  async list(coll, { filter = {}, sort, limit } = {}) {
    let cur = this._c(coll).find(filter, { projection: { _id: 0 } });
    if (sort) cur = cur.sort(sort);
    if (limit) cur = cur.limit(limit);
    return cur.toArray();
  }
  async count(coll, filter = {}) { return this._c(coll).countDocuments(filter); }
  async close() { await this.client.close(); }
}

async function createStore({ mongoUri, dataFile } = {}) {
  if (mongoUri) return new MongoStore(mongoUri).init();
  return new FileStore(dataFile || null).init();
}

module.exports = { createStore, FileStore, MongoStore, COLLECTIONS };
