---
title: "Building strata"
description: "Building my own perfectly imperfect LSM storage engine from scratch in Rust."
pubDatetime: 2026-03-05T00:00:00Z
draft: false
featured: true
tags:
  - engineering
  - rust
  - databases
  - storage-engines
  - systems
---

I just left Google BigQuery after four years. The work was interesting, but I missed building things that were mine. I wanted a project that was fun, challenging, and a little ambitious — something where I could learn, play, and reconnect with the part of engineering I got into this for. I also wanted something tangible I could point to and say: I built this, I understand it end to end, come talk to me about databases.

So I'm building an LSM storage engine from scratch in Rust. I'm calling it `strata`.

This isn't a tutorial. It's what I ran into along the way and what I'm learning from it.

## Table of contents

## Why an LSM Tree?

I have an ambition to build a full database from scratch someday. When I looked at the options, LSM trees stood out. Compared to B-trees, they're easier to reason about — the core data structures are immutable, the write path is append-only, and you don't have to fight concurrency bugs from the start. I wanted to optimize for correctness and developer experience, not raw performance on day one.

There's also something elegant about the design. Every write is just an append. On-disk files are never modified, only created and deleted. The complexity lives in how you merge and organize data across levels, and that part is genuinely fun to think about.

The name comes from geology — layers of rock built up over time. Levels, tiers, strata. It also follows the naming tradition of storage engine projects that sound like they could be indie rock bands.

## Designing Before Building

Before writing code, I spent time reading about LSM design, taking notes, and identifying specific things I wanted to get right early. Some stuff I wanted to explore:

- **Versioning everything.** I'm keeping all versions of every key so I can explore MVCC approaches later. No garbage collection for now. When I eventually integrate a SQL engine on top, I can figure out the best strategy then. LSMs have a cool native way of doing this with internal keys — every key the engine stores is actually a tuple of `(user_key, sequence_number, op_type)` with a custom comparator that sorts by user key ascending, then sequence number descending. Newest version always comes first, which makes point lookups fast.
- **Key-value separation.** The WiscKey paper has a cool optimization where the LSM tree only stores keys and pointers, and the actual values live in a separate log. I haven't implemented this yet but it's on my radar — it could make compaction way cheaper since you're only merging small key-pointer pairs instead of full values.
- **Configurable tiering and leveling.** The Dostoevsky paper's approach to hybrid tiering/leveling sounded fun to implement. I made levels configurable with both a max number of runs and a max size, so I can experiment with different strategies just by changing config values.
- **Manifest files.** I like the idea of an append-only manifest log to maintain the structure of the level tree — which SSTables exist, what level they're in, what key ranges they cover. It's a log that tracks the shape of your other logs. Very meta.
- **K-way merge iterator.** I found `kmerge` in the `itertools` crate and wanted to try it. It uses a min-heap to walk multiple sorted iterators simultaneously — the same primitive you need for both range scans and compaction. I'll need something more capable if I want to do filtering or predicate pushdown in the future, but it's a cool fast start.

## Building It

I used Claude as a design partner and code generator throughout. It let me think at the design level — "should the WAL use segments or truncation?" — instead of fighting syntax for an hour. I like working at this level. It feels more productive, and honestly I either spend the time I save on things I value outside of work, or I just end up spending more time coding and engaging with the design.

After building it, I wasn't fully confident I could explain every detail. Not because I didn't understand the design, but because generating code at speed creates a gap between "I understand the architecture" and "I can trace every line." So I did something that turned out to be really valuable — I had the AI interview me about my own system.

Walk through a write. Walk through a read. Walk through recovery. Explain your decisions.

It surfaced real issues. My range scan implementation probably stops too early — it might return results from only the first level that has matches instead of merging across all levels. I also realized my compaction wasn't handling tombstones correctly in all cases — if a delete and a put for the same key end up in different SSTables, you have to be really careful about the order you process them or you'll resurrect deleted data.

These weren't things I would have caught from running happy-path tests. They came from having to explain my own system out loud and getting pushed on the details.

## Embracing Imperfection

Perfectionism has cost me a lot. Not just in engineering — in my life. I've spent too much time not shipping things, not sharing things, not starting things, because they weren't ready yet. It's exhausting and it doesn't actually produce better work. It just produces less of it.

There's a Japanese concept called wabi-sabi — finding beauty in things that are incomplete, imperfect, impermanent. I've been thinking about that a lot lately. `strata` is my practice at it. My level implementation is janky. Compaction doesn't drop old versions. The WAL segments aren't implemented. There are too many clones and vector materializations. I know all of this, and I'm sharing it anyway.

Kaizen over perfection. The code is broken in ways I can name, and I can fix them one at a time, at my own pace.

## What's Next

There's a lot to do:

- Fixing correctness bugs (the scan issue, tombstone handling)
- Proper streaming over SSTable files instead of materializing everything in memory
- Block indices and bloom filters for faster lookups
- Metrics, monitoring, and tracking invariants
- Tracing throughout the engine

The bigger dream is to add a SQL engine on top. Maybe GlueSQL, maybe something I hand-roll. That's the whole point of owning the storage layer — when I'm ready to build up, I know exactly what's underneath.

If you're curious, the code is at [github.com/nevzheng/strata-db](https://github.com/nevzheng/strata-db). It's very much a work in progress.

I might write up some technical deep dives later if I feel like it. No promises.

## Related Projects

If you're interested in storage engines, these are worth looking at:

**[RocksDB](https://github.com/facebook/rocksdb)** is the reference implementation for modern LSM design. Facebook's fork of LevelDB, used everywhere from CockroachDB to TiKV. Over a decade of development and still actively evolving.

**[LevelDB](https://github.com/google/leveldb)** is Google's original, written by Jeff Dean and Sanjay Ghemawat. Simpler than RocksDB and great for reading the source to understand core LSM mechanics.

**[Pebble](https://github.com/cockroachdb/pebble)** is CockroachDB's storage engine in Go. Started as a LevelDB port, now heavily diverged. Clean codebase with well-documented design decisions.

**[BadgerDB](https://github.com/dgraph-io/badger)** is Dgraph's engine in Go. It separates keys and values based on the WiscKey paper — keys live in the LSM tree, values in a separate log.

**[sled](https://github.com/spacejam/sled)** is the most prominent Rust embedded database, though it's a lock-free B+ tree rather than an LSM. Worth studying for Rust-specific idioms in storage engine design.

**[mini-lsm](https://github.com/skyzh/mini-lsm)** is a great step-by-step LSM tutorial in Rust, written by someone I know from CMU. Highly recommend if you're building your own.

**[AgateDB](https://github.com/tikv/agatedb)** is a Rust port of BadgerDB from the TiKV project. Another good Rust LSM reference.

## References

- Patrick O'Neil, Edward Cheng, Dieter Gawlick, Elizabeth O'Neil. *The Log-Structured Merge-Tree (LSM-Tree)*. Acta Informatica, 1996.
- Niv Dayan and Stratos Idreos. *Dostoevsky: Better Space-Time Trade-Offs for LSM-Tree Based Key-Value Stores via Adaptive Removal of Superfluous Merging*. SIGMOD, 2018.
- Lanyue Lu, Thanumalayan S. Pillai, Andrea C. Arpaci-Dusseau, Remzi H. Arpaci-Dusseau. *WiscKey: Separating Keys from Values in SSD-Conscious Storage*. FAST, 2016.
- Chi Zhang, Skyzh. *mini-lsm: A tutorial to build an LSM-Tree storage engine in Rust*. [github.com/skyzh/mini-lsm](https://github.com/skyzh/mini-lsm)
