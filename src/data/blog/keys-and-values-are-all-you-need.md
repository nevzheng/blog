---
title: "Keys and Values Are All You Need"
description: "Bootstrapping a SQL catalog on a flat key-value store, end to end."
pubDatetime: 2026-05-15T00:00:00Z
draft: false
featured: true
tags:
  - engineering
  - rust
  - databases
  - storage-engines
  - systems
---

This post is a walkthrough: how to bootstrap a SQL catalog on top of a key-value store, every write end to end — from a name, to a UUID, to a row in a system table, to a durable user record.

It's based on what I worked through while building Strata, my personal LSM project, but the recipe is general. A handful of conventions on top of a four-operation KV API gets you surprisingly far. Keys and values really are all you need.

> A note on the code: snippets throughout are rusty pseudocode for ease of explanation — not necessarily lifted directly from Strata.

## Table of contents

## Everything is a Table

In databases, anything you can model as a table tends to be easier to work with. Indexes, metadata, system configuration. SQL already operates on tables, so why not store everything that way too?
But how do you represent a table in a system that only speaks key-value? StrataDB's storage engine exposes just four operations:

```rust
pub trait StorageEngine {
    /// Insert or update a key-value pair.
    fn put(&mut self, key: &[u8], value: &[u8]);

    /// Retrieve the value for a key, or None if it doesn't exist.
    fn get(&self, key: &[u8]) -> Option<Vec<u8>>;

    /// Delete a key by writing a tombstone.
    fn delete(&mut self, key: &[u8]);

    /// Return all key-value pairs whose keys fall within the given range,
    /// sorted by key.
    fn scan(&self, range: impl RangeBounds<Vec<u8>>) -> Vec<KVPair>;
}
```

## What's a table anyway?

Before we can store anything, we need to define what we're storing. In Strata, the catalog is organized around three concepts borrowed from BigQuery:

* Project — the top-level namespace, like an organization or account
* Dataset — a logical grouping of tables within a project
* Table — a named collection of rows with a schema

Each level has a corresponding metadata type:

```rust
pub struct ProjectId(Uuid);
pub struct DatasetId(Uuid);
pub struct TableId(Uuid);

pub struct ProjectMeta {
    pub id: ProjectId,
    pub name: String,
}

pub struct DatasetMeta {
    pub id: DatasetId,
    pub name: String,
}

pub struct TableMeta {
    pub id: TableId,
    pub name: String,
    pub schema: Schema,
}
```

Names are human-readable. IDs are stable and opaque — the rest of the system never references a resource by name internally, only by ID. Each ID is a new type wrapping a UUID. The compiler now enforces that you can't accidentally pass a `TableId` where a `ProjectId` is expected — a mistake that would be invisible with raw `Uuid` values and silent at runtime.

Tables additionally carry a Schema — a list of typed fields that describes the shape of its rows.

## The Catalog API

The public API exposes these as a fluent, scoped interface:

```rust
pub trait CatalogApi {
    fn project(&self, name: &str) -> ProjectScope;
}

pub trait ProjectScope {
    fn create_dataset(&self, name: &str) -> DatasetScope;
    fn dataset(&self, name: &str) -> DatasetScope;
    fn drop_dataset(&self, name: &str);
    fn list_datasets(&self) -> Vec<String>;
}

pub trait DatasetScope {
    fn create_table(&self, name: &str, schema: Schema) -> TableScope;
    fn table(&self, name: &str) -> TableScope;
    fn drop_table(&self, name: &str);
    fn list_tables(&self) -> Vec<String>;
}

pub trait TableScope {
    fn put(&self, key: &[u8], value: Value);
    fn get(&self, key: &[u8]) -> Option<Value>;
    fn delete(&self, key: &[u8]);
}

// Create a table
let table = db
    .project("acme")
    .create_dataset("metrics")
    .create_table("events", schema);

// Write and read a row
table.put(b"event:001", json!({ "type": "click", "ts": 1234567890 }));
table.get(b"event:001"); // Some({"type": "click", "ts": 1234567890})

// Navigate to an existing table
let table = db
    .project("acme")
    .dataset("metrics")
    .table("events");

// List tables in a dataset
db.project("acme")
  .dataset("metrics")
  .list_tables(); // ["events"]
```

## The Challenge

We have a KV store that speaks bytes. We have a catalog that speaks projects, datasets, and tables. How do we bridge the gap?

## Composite Keys

Encode the full namespace into the key itself, and the flat KV store gets structure for free.

```txt
{project_id}|{dataset_id}|{table_id}|{user_key}|{version}→ value
```

Every row in the database gets a key that encodes exactly where it lives. Two rows in different tables can never collide because their keys differ at the table_id segment. And because the KV store sorts keys lexicographically, all rows in the same table are physically adjacent — listing them is just a prefix scan. Appending a version gives us a basis for MVCC for free. Multiple versions of the same row sort together naturally, laying the groundwork for point-in-time reads and snapshot isolation down the line.

That's the entire trick. And it's not a new one. CockroachDB maps every SQL row into a composite key of the form {table_id}_{primary_key}_{row_id} and relies on prefix scans to retrieve all rows in a table — the same idea, just at a larger scale. Google's Spanner started life as a KV store and grew into a full relational database by layering SQL on top. TiDB takes the same approach, splitting into TiKV (the storage layer) and TiDB (the SQL engine) as separate components. The composite key scheme is how all of them do it.

## System Tables & Reserved UUIDs

To store catalog metadata, we need somewhere to put it. But here's the bootstrapping problem: the catalog lives in tables, and tables are defined by the catalog. Where does it start?

Hardcode a set of reserved system tables that exist before anything else. Inspired by IP address block reservations — where certain ranges like `127.0.0.0/8` or `192.168.0.0/16` are permanently set aside — Strata reserves a specific UUID pattern for system use:

```txt
Reserved prefix: ffffffff-ffff-****-****-************
```

UUIDv7 encodes a unix-millisecond timestamp in the first 48 bits. A real minted v7 ID can't reach `ffffffff-ffff` until roughly the year 10895 — so this range is safe to claim forever.

Within that reserved space, Strata defines a system project, a catalog dataset, and a fixed set of system tables:

```txt
_system project:    ffffffff-ffff-0000-0000-000000000000  (ProjectId)
_catalog dataset:   ffffffff-ffff-0000-0000-000000000000  (DatasetId)

System tables:
  _uuids:           ffffffff-ffff-0000-0000-000000000000  name -> UUID
  _projects:        ffffffff-ffff-0000-0000-000000000001  ProjectId -> ProjectMeta
  _datasets:        ffffffff-ffff-0000-0000-000000000002  (ProjectId, DatasetId) -> DatasetMeta
  _tables:          ffffffff-ffff-0000-0000-000000000003  (ProjectId, DatasetId, TableId) -> TableMeta
```

New system tables just take the next suffix — `...000000000004`, `...000000000005`, and so on. The same newtype pattern that prevents ID confusion at call sites also ensures a `ProjectId` and a `TableId` with identical byte patterns never collide — they're different types.

## Creating a Table: End to End

Creating a new table takes a sequence of writes. Let's walk through what happens when a user calls:

```rust
db.project("acme")
  .create_dataset("metrics")
  .create_table("events", schema);
```

### Step 1: Mint new IDs

Each new resource gets a fresh UUIDv7:

```rust
let project_id = ProjectId::new();  // e.g. 019847ab-ffff-7000-...
let dataset_id = DatasetId::new();
let table_id   = TableId::new();
```

### Step 2: Register in `_uuids`

Users address resources by name (`db.project("acme").dataset("metrics")`), so name → ID lookups happen on every call. Scanning the parent's metadata table each time would be wasteful. `_uuids` is the dedicated lookup — a flat name → UUID index that also doubles as a uniqueness check at insert time:

```txt
_uuids: "acme"    → 019847ab-ffff-7000-...
_uuids: "metrics" → 019847ac-ffff-7000-...
_uuids: "events"  → 019847ad-ffff-7000-...
```

### Step 3: Write the metadata

With IDs in hand, write the metadata rows to the system tables:

```txt
_projects: project_id                          → ProjectMeta { id, name: "acme" }
_datasets: project_id + dataset_id             → DatasetMeta { id, name: "metrics" }
_tables:   project_id + dataset_id + table_id  → TableMeta   { id, name: "events", schema }
```

### Step 4: Write rows

The table now exists in the catalog. Writes go to the user keyspace:

```txt
project_id | dataset_id | table_id | "event:001" → { "type": "click", "ts": 1234567890 }
```

That's the full path from a name to a durable row in the engine.

## Wiring It Together

Once we have the system tables bootstrapped and the composite key scheme in place, the catalog API almost writes itself. Every `create_*` call follows the same pattern: mint a UUID, check for existence, write the metadata row.

Here's `create_project`, close to the actual implementation:

```rust
pub(crate) fn create_project(&self, name: &str) -> Result<ProjectMeta, CatalogError> {
    if self.open_project(name)?.is_some() {
        return Err(CatalogError::AlreadyExists {
            kind: ResourceKind::Project,
            name: name.to_string(),
        });
    }
    let meta = ProjectMeta {
        id: ProjectId::new(),
        name: name.to_string(),
    };
    put_meta(&self.engine, PROJECTS_TABLE_ID, name.as_bytes().to_vec(), &meta)?;
    Ok(meta)
}
```

And the underlying `put_meta` helper that every catalog write goes through:

```rust
fn put_meta<T: serde::Serialize>(
    engine: &SharedEngine,
    system_table: TableId,
    user_key: Vec<u8>,
    meta: &T,
) -> Result<(), CatalogError> {
    let row_key = RowKey::new(
        SYSTEM_PROJECT_ID,
        CATALOG_DATASET_ID,
        system_table,
        user_key,
    );
    let value = serde_json::to_vec(meta)?;
    engine.lock().unwrap().put(&row_key.encode(), &value)
}
```

That's it. A `ProjectMeta` struct serialized to JSON, written to a composite key in the system namespace. The same pattern repeats for datasets and tables — just different `system_table` IDs and user key schemes.

Durable catalog objects, stored as ordinary rows alongside user data.

And user writes follow the exact same path. A `Table` handle carries the three IDs it was created with, and `table.put` constructs a `RowKey` from them just like `put_meta` does — only in a user namespace instead of the system one. The catalog and the data live in the same engine, behind the same key scheme.

The catalog gave us the IDs. The IDs gave us the key. The key gave us a durable row.

## Implications

Two things fall out of this layout.

**Locality is free.** Every row in a table shares a 48-byte prefix and the engine sorts lexicographically, so all of a table's rows end up physically adjacent on disk. Scans don't seek, they stream.

**The LSM is flatter than the catalog suggests.** Projects, datasets, and tables form a hierarchy in the API, but the storage engine doesn't organize by logical entity — it organizes by recency and key range: memtable, L0, L1, L2, each level a forest of sorted runs. A single table's rows can be split across SSTables at different levels and reassembled at read time by the merging iterator. The hierarchy is a sort order, not a layout.

## What's Next

This is a start, not a finish. The shortlist:

* **Transactions.** Catalog ops are multiple writes and not atomic today. The LSM's WAL gives durability at the storage layer; a higher-level transaction log is the next thing on top.
* **Richer encoding and types.** Row values are JSON blobs and the schema model is minimal. A binary or columnar encoding and a real type system are both on the list.
* **Correctness gaps.** Dropping a project orphans its datasets and tables in the engine. A future pass will walk the hierarchy and clean up transactionally.
* **A SQL surface.** A parser and planner that turns `SELECT * FROM acme.metrics.events WHERE event = "click"` into a prefix scan on the right composite key. This is the whole reason for the catalog.
* **Alternative encodings.** Row vs column vs PAX is a key-encoding choice on the same KV engine. A column store is `{table}{column}{row_id} → cell_value`; PAX-style hybrids fall out of grouping rows into pages first. Worth exploring once the row store is solid.
* **Tighter prefix encoding.** The 48-byte UUID prefix is currently amortized by block-level prefix compression in the SSTable layer — runs of the same prefix collapse to near-zero on disk — but a tighter scheme could shave more. Not on the critical path.

## Further Reading

More on the composite-key approach and KV-as-foundation idea:

* [CockroachDB key encoding](https://github.com/cockroachdb/cockroach/blob/master/docs/tech-notes/encoding.md) — the production version of the composite-key scheme at scale.
* [Phil Eaton on key-value databases](https://notes.eatonphil.com/whats-the-big-deal-about-key-value-databases.html) — a broader overview of why so many systems are KV stores underneath.
* [TiKV](https://github.com/tikv/tikv) — the storage layer TiDB layers SQL on top of.

If you're curious, the code is at [github.com/nevzheng/strata-db](https://github.com/nevzheng/strata-db).

If you enjoyed this post or found it useful, consider [buying me a coffee](https://ko-fi.com/nevzheng).

[Discuss on Hacker News](https://news.ycombinator.com/item?id=48154631)
