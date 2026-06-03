---
title: "Beyond Inline Values: Evolving Strata's Storage Engine"
description: "An architectural decision record: why Strata is moving from inline values to block-based storage."
pubDatetime: 2026-06-03T00:00:00Z
draft: false
featured: false
tags:
  - engineering
  - rust
  - databases
  - storage-engines
  - systems
---

Strata is a single-node LSM storage engine I'm building in Rust, with a SQL layer on top. Right now every value is stored inline in the LSM — a deliberate bootstrapping decision to get SQL running end to end. Now that the basics work, there's an opportunity to replace inline storage with something better.

This post is an Architectural Decision Record (ADR). It records a decision I'm proposing for Strata — to replace inline storage with a block-based abstraction — and walks through the reasoning: the problem, the requirements, the options I compared, and why I landed where I did.

> Status: Proposed. The repo is at [github.com/nevzheng/strata-db](https://github.com/nevzheng/strata-db).

## Table of contents

## 1. Context

Strata is a single-node LSM storage engine written in Rust with a SQL layer on top. Currently all values are stored inline in the LSM. This was a deliberate bootstrapping decision to get SQL running end-to-end. Now that the basics work, there is an opportunity to improve performance and flexibility by replacing inline storage with a better abstraction.

This document argues for replacing inline storage with a block-based abstraction. We define the problem, establish requirements, compare options, and make a decision.

## 2. Problem Statement

Inline storage couples keys, values, and metadata with no abstraction boundary, making it hard to build on and expensive to operate.

### Flexibility

- **No logical structure:** Keys, values, and metadata are crammed into a single flat encoding with no clean extension points.
- **Hard to evolve:** Any change to the encoding requires rewriting existing data. Without indirection or versioning, there is no graceful migration path.
- **No physical layout flexibility:** Inline tuples lock Strata into a row-oriented layout. Our roadmap targets diverse OLTP and OLAP workloads, and this is a hard blocker for performance reasons.

### Performance

Good storage design maximizes I/O utilization. Every byte read or written should contribute to a query result or a durable write. Inline storage wastes I/O on data that doesn't matter.

- **Read amplification:** Inline storage forces every read to scan whole tuples regardless of selectivity, wasting I/O bandwidth on irrelevant data.
- **Write amplification:** Every write rewrites the entire key-value pair. Without delta support, even a small field update rewrites the whole tuple.
- **Compaction amplification:** Compaction must read and rewrite full tuples to make decisions that should only require keys and metadata. The physical layout offers no shortcuts.
- **Space amplification:** LSM tree size is proportional to the number of tuples multiplied by value size. For wide rows, value size dominates. Dead tuples compound this until compaction runs.
- **No cache:** Strata has no caching layer. Every read touches disk.
- **No locality:** Key-to-tuple is a poor basis for a cache. Without a logical unit of data there is no meaningful way to exploit locality, prefetch, or batch reads.

### Roadmap Blockers

- **No group integrity:** Checksums must be applied per key-value pair. Without a logical grouping boundary, there is no efficient unit for checksumming or validation.
- **MVCC is structurally inefficient:** Versions are scattered throughout the tree with no logical grouping. Merging and navigating versions requires scanning across levels rather than following a local chain.
- **High risk of regression:** Inline tuples are hard to reason about in isolation. Any change to the encoding risks affecting every feature that touches tuple data. Abstraction and indirection would reduce this risk by isolating concerns.

## 3. Requirements

In priority order:

**🥇 1. Flexibility / Evolvability / Maintainability**

New features should plug in without breaking existing ones. Changes should be isolated to their own component. Components should be replaceable without churn.

**🥈 2. Correctness**

The system should be easy to reason about and verify. Components should be testable in isolation. Invariants should be assertable from first principles. If we can't test it, we can't trust it.

**🥉 3. Performance**

We should be able to reason about performance from the design before measuring it. Key metrics: read amplification, write amplification, space amplification, p99 latency, cache hit rate, and scan throughput. Performance claims should be testable and backed by benchmarks.

## 4. Evaluation

Dimensions chosen where options differ meaningfully. Dimensions where all options score similarly (concurrency, correctness/verifiability) are not included.

| Dimension | A. Inline | B. WiscKey | C. Block-Based |
| --- | --- | --- | --- |
| **Flexibility** 🥇 | 🔴 No extension point. Any new capability requires touching the whole encoding. | 🟡 Key/value separation helps but the value log format is rigid and unstructured. | 🟢 High extensibility. New block types can be invented as needed without touching existing blocks. |
| **MVCC Readiness** 🥇🥈 | 🔴 Each version = full tuple copy. N versions = N full copies in tree. | 🔴 Value log has no native version structure. MVCC requires additional indexing into the log. GC and snapshot isolation conflict directly. | 🟢 Natural fit. Stable block IDs enable delta chains without data copies. |
| **Complexity** 🥇 | 🟢 Dead simple. Already working. | 🟡 Moderate. GC complexity. Two-path I/O. | 🔴 Most complex. Upfront design decisions required. |
| **Read Amplification** 🥉 *useful work per read I/O* | 🔴 Scans full tuple regardless of selectivity. We pay for data we don't need on every read. | 🟡 Two I/Os per read, both may return irrelevant data. No opportunity to optimize what gets read. | 🟢 More seeks but locality and prefetching mean every byte read can contribute to the query result. Partial reads possible. |
| **Write Amplification** 🥉 *useful work per write I/O* | 🔴 Rewrites full tuple and metadata regardless of what changed. No delta support. | 🟢 Append-only write path. Only the new value is written. Read path becomes more complex but write usefulness is high. | 🟡 Delta blocks allow writing only what changed. Not yet implemented. Currently rewrites full blocks. High ceiling, not yet realized. |
| **Compaction Amplification** 🥉 *reads and writes required to complete compaction vs live data kept* | 🔴 Must read and rewrite full tuples. Physical layout offers no shortcuts. | 🟢 Compaction touches small keys only. Values untouched. Log GC is separate cost. | 🟢 Indirection lets compaction touch only blocks that need merging or deletion. Opportunities to skip rewriting unchanged blocks entirely. |
| **Space Amplification** 🥉 *physical storage cost per logical tuple or MVCC chain* | 🔴 Physical cost scales with tuple width × number of versions. Dead versions sit on disk until compaction. For wide rows, cost is dominated by value size. | 🟡 LSM stays lean — keys only. Value log accumulates dead values until GC runs. Physical cost depends heavily on GC frequency. | 🟢 Physical cost bounded at the block level. Dead blocks tracked and reclaimed during compaction. Indirection means logical deletes don't require immediate physical rewrites. |
| **Caching / Locality** 🥉 *ability to cache and exploit data locality* | 🔴 No cache. Key-to-tuple is a poor basis for locality or prefetching. | 🔴 No natural unit of locality. A caching strategy would need to be designed from scratch with no good logical structure to build on. | 🟢 Buffer pool keyed by stable block ID. Natural unit for locality and prefetching. |

## 5. Decision

**We choose Option C — Block-Based Storage.**

Block-based storage best balances our three requirements. It provides strong indirection, extensibility, and a clean abstraction boundary — new features are easy to reason about and plug in as new block types without touching existing storage.

On performance, there are real trade-offs. Lookups require additional I/O for block resolution and cache misses add latency. But the buffer pool and stable block IDs create meaningful opportunities: prefetching, locality exploitation, and smart caching strategies that maximize useful work per I/O. The performance ceiling is high and the trade-offs are measurable.

Inline storage is eliminated because its limitations are structural and not fixable. It is not a good foundation for a database storage engine.

WiscKey is eliminated because while the value log is fast for writes, it is hard to build additional features on top without effectively reinventing block-based storage. We want the insight — indirection and append-only writes — without the structural limitations.

## 6. Options

### A. Status Quo — Inline Values

Row data is stored inline alongside keys in SSTable entries. The tuple is encoded directly in the entry — there is no indirection.

```text
[ key_len | key_bytes | version | tuple_bytes ... ]
                                  ^--- full row encoded here
```

**Key features:**

- No indirection — keys, values, and metadata stored together in a single flat entry
- SSTable size scales with tuple width
- Simple to implement

### B. WiscKey — Value Log

*Lu et al., FAST '16*

Keys stay in the LSM. Values are written to a separate append-only value log. The SSTable entry stores a pointer (log offset) instead of the value itself. LSM compaction only touches keys — values are never moved. Value log GC is a separate process responsible for reclaiming dead values and consolidating versions.

```text
SSTable:  [ key | log_offset ] [ key | log_offset ] [ key | log_offset ] ...

Log:      [ tuple ]            [ tuple ]            [ tuple ]            ...
```

**Key features:**

- Keys and values separated — SSTable stores key → log offset, values in append-only log
- LSM compaction touches keys only — value log GC is separate
- Append-only writes are fast and sequential

### C. Block-Based Storage — SSTable Format

*LevelDB Table Format; RocksDB Block Cache; Pebble*

Values are stored in fixed-size typed blocks on disk. The SSTable index stores a block ID and offset instead of an inline value. An in-memory buffer pool sits in front of disk I/O, keyed by stable block ID.

```text
SSTable:  [ key | block_id | offset ] [ key | block_id | offset ] ...

Blocks:   [ header          ]         [ header          ]
          [----------------]         [----------------]
          [ tuple ][ tuple ]         [ tuple ][ tuple ]
          [ tuple ][ tuple ]         [ tuple ][ tuple ]
          ...                        ...
```

**Key features:**

- SSTable index stores key → block ID + offset — values live in typed blocks on disk
- Stable block IDs — blocks referenceable from buffer pool, manifests, catalogs, MVCC chains
- In-memory buffer pool keyed by block ID — natural unit for caching and locality
- Typed blocks — new block types can be invented as needed
- Mutation via pointer surgery — update references, not data

## Appendix A — Future Work & Out of Scope

This document is an Architectural Decision Record (ADR). It records the decision to adopt block-based storage and the reasoning behind it. Implementation details are out of scope and each warrants a dedicated design doc.

Performance claims in this document are reasoned from design principles. Benchmarks will be required to validate them.

**Deferred to follow-on design docs:**

- **Block cache and buffer pool:** How do we implement the in-memory buffer pool? What eviction policy? How do we size it?
- **MVCC and mutation log:** How do we design the mutation log? How do deletes and version chains interact with the block model?
- **Compaction strategy:** How do we decide what to compact and when? How does compaction interact with the buffer pool and block lifecycle?
- **Logical vs physical block ID mapping:** How does the manifest map logical block IDs to physical file locations? How does this survive compaction and crash recovery?
- **Crash recovery:** How do we ensure consistency on restart? What does the WAL look like? How do we recover the manifest?
- **Concurrency:** How do we handle concurrent reads and writes? How is the buffer pool made thread-safe?
- **Block size tuning:** What is the right block size for our workloads? How do we benchmark this?
- **Compression:** When and at what granularity do we compress? How does compression interact with the block format?
- **Bloom filters:** How do we add per-block or per-SSTable bloom filters to reduce unnecessary reads?
- **Columnar / PAX layout support:** How do we support alternative layouts within the block abstraction?
- **Encoding versioning:** How do block formats evolve over time without breaking existing data?
- **Observability and metrics:** How do we instrument the block cache, compaction, and I/O paths to validate performance claims?

## References

1. O'Neil et al. — *The Log-Structured Merge-Tree (LSM-Tree)*, 1996
2. Lu et al. — *WiscKey: Separating Keys from Values in SSD-Conscious Storage*, FAST '16
3. Google — [LevelDB Table Format](https://github.com/google/leveldb/blob/main/doc/table_format.md)
4. Meta — [RocksDB Block Cache Documentation](https://github.com/facebook/rocksdb/wiki/Block-Cache)
5. CockroachDB — [Pebble](https://github.com/cockroachdb/pebble)
6. Matei et al. — *CockroachDB: The Resilient Geo-Distributed SQL Database*, SIGMOD '20
7. [ADR Format Reference](https://adr.github.io)

---

If you enjoyed this post or found it useful, consider [buying me a coffee](https://ko-fi.com/nevzheng).

If you're curious, the code is at [github.com/nevzheng/strata-db](https://github.com/nevzheng/strata-db).
