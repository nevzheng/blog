---
title: "Ow! My Foot!"
description: "Errors, opinions, and the rakes I've stepped on."
pubDatetime: 2026-02-28T00:00:00Z
featured: true
tags:
  - engineering
  - rust
  - cpp
  - go
  - error-handling
  - systems
---

_A survey of error handling across C, Go, Rust, and Google's Absl — and what I think works. Strong opinions, weakly held, gently shared._

## Table of contents

If you've spent any time building production systems, you know that error handling is one of those things that separates code that works on your laptop from code that works at 3 AM when something unexpected happens. I've worked with error handling across languages and environments — from Google's C++ codebase to Rust's ecosystem — and I've developed some strong opinions about what works and what doesn't.

This isn't a tutorial. It's a set of principles I've arrived at through experience, a comparison of how popular languages and libraries measure up against those principles, and some hot takes you're welcome to argue with.

## 1. At the Dawn of the Unix Epoch

Before `Result<T, E>`, before `try/catch`, before `if err != nil`, before even `errno` — there was hardware.

Your CPU had a status register. Bits in that register told you what went wrong — overflow, divide by zero, invalid opcode. You checked the flags. Or you didn't. Nobody made you.

```asm
; x86 — the original error handling
mov  ax, 10
mov  bx, 0
div  bx              ; triggers INT 0 — divide error exception
                     ; the CPU sets flags and jumps to an interrupt vector
                     ; if you registered a handler: maybe you survive
                     ; if you didn't: the system decides for you
```

```asm
; x86 EFLAGS register — error handling at the metal
; Bits that tell you what just happened:
;
;   CF (bit 0)  — Carry Flag: unsigned overflow, or the conventional
;                  "something went wrong" signal between routines
;   OF (bit 11) — Overflow Flag: signed arithmetic overflowed
;   ZF (bit 6)  — Zero Flag: result was zero (division, comparison)
;   SF (bit 7)  — Sign Flag: result was negative
;   TF (bit 8)  — Trap Flag: single-step for debugging
;                  (the original breakpoint)
;
; These aren't error codes. They're not error types.
; They're individual bits. You check them or you don't.
; The CPU doesn't care either way.

add  eax, ebx        ; did this overflow?
jo   overflow_handler ; jump if OF is set — you remembered to check!
                      ; if you didn't: you now have a silently wrong value
                      ; and you won't know until something downstream
                      ; explodes. Sound familiar?
```

If you were fancy, you set up an Interrupt Service Routine to handle the fault gracefully. If you weren't, the CPU just... stopped. Or reset. Or did something undefined. The "error handling strategy" was literally "did you wire up the right entry in the interrupt vector table before something went wrong."

```asm
; Slightly more civilized: checking the carry flag after an operation
clc                  ; clear carry flag
call some_routine    ; convention: set carry flag on error
jc   error_handler   ; jump if carry — our "if err != nil" circa 1978
; happy path continues here
```

And if you didn't set up your error handlers? Before the watchdog timer existed, there was nothing. Your program hung and that was just... the state of things now. Your microcontroller stared into the void and the void stared back. Maybe someone noticed. Maybe they power-cycled it. Maybe the satellite was in orbit and nobody could reach it.

The watchdog timer was invented because we learned the hard way that code _will_ hang, and somebody has to be responsible for noticing. So we built a tiny hardware dead man's switch: pet the watchdog periodically to prove you're alive, or it reboots you. The first error recovery mechanism wasn't even software — it was a countdown timer and a hard reset line. No graceful degradation. No error log. Just a cold reboot and whatever state your device happened to be in when the watchdog bit.

```c
// On a microcontroller, this is still real life:
void HardFault_Handler(void) {
    // You ended up here because something went very wrong
    // — bad memory access, stack overflow, divide by zero.
    // Your options:
    //   1. Log what you can to flash storage
    //   2. Set a "we crashed" flag for next boot
    //   3. Let the watchdog do its thing
    //
    // There is no try/catch. There is no Result<T, E>.
    // There is only this handler and the void.
    __NVIC_SystemReset();
}
```

This isn't ancient history. If you're writing firmware, working on embedded systems, or programming microcontrollers, this is Tuesday. The STM32 on your desk right now has a `HardFault_Handler` and a watchdog timer, and if you don't respect them, your drone falls out of the sky or your medical device does something you'll be explaining to a regulator.

No types. No stack traces. No error messages. Just a bit in a register, a conditional jump, and a watchdog waiting to eat your lunch. Everything we'll talk about in this post — every language feature, every library, every heated debate about `?` vs `try/catch` — is descended from this. We've spent 40+ years building increasingly sophisticated answers to the same question the CPU asked at boot: _"something went wrong — now what?"_

We've gotten better at it. Mostly.

---

## 2. Principles

The first principle of error handling is accepting two things: Murphy's Law and a little bit of Zen.

Something _will_ go wrong. Your network call will timeout. Your database will hiccup. Your user will send you something absolutely unhinged. A cosmic ray will flip a bit. This isn't pessimism — it's the first honest thing you can say about any system of sufficient complexity.

The question was never _"will something fail?"_ — it was always _"when it fails, what happens to everything around it?"_

That reframe changes everything. Error handling isn't defensive boilerplate you sprinkle on after the real code is written. It _is_ the design. The happy path is the easy part — any junior engineer can write code that works when everything goes right. The craft is in what happens when things don't.

Once you internalize that — really internalize it, not just nod at it — the rest follows naturally.

The practical consequence is: stop trying to control every outcome. You can't. Instead, think in terms of containment. A firefighter doesn't try to stop every fire from ever starting — they build firebreaks, they decide which sections can burn, and they protect what matters most. Error handling is the same discipline. Define your boundaries. Know your blast radius. If this request fails, that's fine — the user gets an error. If this request takes down the database connection pool, that's a five-alarm fire. The difference isn't luck. It's design.

This idea isn't new — embedded systems and safety-critical engineering have formalized it for decades as _error domains_ or _fault domains_. When you're designing avionics or medical devices, you don't get to hope that a failure in one subsystem won't cascade. You _prove_ it won't, with hardware partitioning and formal verification. Your car's infotainment system can crash without affecting your brakes — that's not luck, that's a deliberately enforced domain boundary. Software error handling is the same principle applied with less rigor and (usually) lower stakes — but the thinking is identical. Contain the fault. Protect what matters. Let what can fail, fail safely.

### 2.1 Think in Error Domains and Blast Radius

When an error occurs, the first question should be: _what's the scope of the failure?_

This is what I call the error domain — the boundary of what a failure can affect. Good error handling is fundamentally about **containment**. In a well-designed system:

- **A bad request fails the request.** The user gets an error, life goes on.
- **A bad request does NOT crash the service.** Other users, other requests — they should be completely unaffected.
- **A bad request does NOT corrupt shared state.** If a failure can poison your database or leave a cache in an inconsistent state, you have a design problem, not just an error handling problem.

This is the most important principle and it directly informs why I prefer result/status-based error handling over exceptions. Exceptions make it dangerously easy to accidentally unwind past the boundaries you intended, tearing down a connection pool or leaving a mutex locked. Status-based returns naturally encourage you to handle errors at the right level — because you _have to_ deal with the return value.

At scale, the mantra is: **fail the request, not the process.**

### 2.2 The Happy Path Should Read Clean

When I open a file, I want to immediately understand what the code _does_. Error handling should be visible — I need to know where things can fail — but it shouldn't dominate the reading experience.

This is a spectrum. On one end, you have exception-based languages where the happy path looks clean but failure paths are completely invisible. On the other end, you have Go, where `if err != nil` blocks are so pervasive they drown out the actual logic. The sweet spot is somewhere in between: **error handling should be annotated but not overwhelming.**

Rust's `?` operator nails this. A single character marks "this can fail, and if it does, we propagate the error." You see it, you know what it means, and it doesn't eat three lines of your function.

### 2.3 Errors Should Be Easy to Write AND Easy to Debug

These are two different things and they're both important.

**Easy to write** means: when I'm implementing a function, creating and returning an error shouldn't require a bunch of boilerplate. If it's annoying to do the right thing, people will do the wrong thing — they'll return a generic error, or worse, just unwrap and hope for the best.

**Easy to debug** means: when I'm staring at a log at 2 AM, the error should tell me _what happened_ in human-readable terms. Stack traces are a mechanical representation — they tell you _where_ code executed, but not _why_ or _what was being attempted_. What you actually want is context: "Failed to load user profile for user_id=12345 from the accounts service." That's actionable. A mangled stack trace through three layers of async runtime is not.

The primary consumer of error output is a human being trying to figure out what went wrong. Design for that.

### 2.4 Error Taxonomy Tends Toward Bikeshedding

Here's my hot take: excessive classification of errors — elaborate enum hierarchies, deeply nested error types — often becomes bikeshedding.

Ask yourself honestly: how often do you actually _programmatically_ match on specific error types to change behavior at runtime? For **library code**, it matters — your callers need to know if they got a "not found" vs. "permission denied" so they can react differently. For **application code** stitching libraries together? Most of the time you're logging the error and returning a 500 to the user. You need a good message, not a precise taxonomy.

This doesn't mean error types don't matter. It means the energy you spend designing a perfect error hierarchy is often better spent on writing clear error messages and establishing consistent conventions across your team.

To be clear — a small, fixed, shared taxonomy like Absl's 17 canonical codes is very different from every team inventing bespoke error hierarchies. The value is in the _shared_ part, not the _elaborate_ part. If your whole org agrees on the same 17 codes, that's a standard. If every team designs their own artisanal error enum, that's where the bikeshedding creeps in.

### 2.5 Good Machinery Makes It Easy to Do the Right Thing

No amount of language features will save you from bad error design. But good machinery — good libraries, good conventions, good tooling — makes it dramatically more likely that people _will_ do the right thing.

The best error handling systems are the ones where the path of least resistance is also the correct path. If returning a properly annotated error is easier than ignoring it, people will return properly annotated errors. If it's a pain, they won't.

This is ultimately an engineering discipline and organizational problem. Languages and libraries are enablers, not solutions.

---

## 3. The Comparison

With those principles in mind, let's walk through how popular approaches to error handling measure up.

### 3.1 C: The Baseline (It's Terrible)

C is where we all started, and it's instructive as a "before" picture of what we're trying to improve on.

```c
#include <stdio.h>
#include <errno.h>
#include <string.h>

int process_file(const char* filename) {
    FILE* f = fopen(filename, "r");
    if (f == NULL) {
        // errno is global mutable state. Hope nobody changed it.
        fprintf(stderr, "Failed to open %s: %s\n", filename, strerror(errno));
        return -1;  // What does -1 mean? Who knows!
    }

    char buffer[1024];
    if (fread(buffer, 1, sizeof(buffer), f) == 0) {
        if (ferror(f)) {
            // Did we check this? Did we forget?
            // The compiler certainly won't tell us.
            fclose(f);
            return -2;  // Different number, same vibes
        }
    }

    fclose(f);
    return 0;  // Success! Probably.
}

// Meanwhile, the caller:
int result = process_file("data.txt");
// Nothing forces us to check `result`. We can just... not.
```

Everything about this is painful. Error codes are just integers with no type safety. `errno` is global mutable state that any function call can silently overwrite. Nothing forces you to check return values. Every project invents its own conventions for what `-1` means. There are no standard error types, no standard error structs, no ergonomic way to propagate errors up the call stack.

C error handling works only through sheer programming discipline, and unaided discipline doesn't scale.

### 3.2 Exceptions: The Implicit Failure Path

Exception-based languages — Java, Python, C#, and others — took a different approach: errors are thrown and caught, keeping the happy path clean.

```python
def process_user_data(user_id: str) -> dict:
    # Look how clean this is! What could go wrong?
    config = load_config("settings.yaml")        # FileNotFoundError? YAMLError?
    db = connect_to_database(config["db_url"])    # ConnectionError? TimeoutError?
    user = db.query("SELECT * FROM users WHERE id = %s", (user_id,))  # SQLError?
    profile = fetch_profile(user["profile_url"])  # HTTPError? JSONDecodeError?
    return merge_data(user, profile)              # TypeError? KeyError?

# Five different things can fail, and the code gives you zero indication of that.
# So we slap a try/catch around it:
try:
    result = process_user_data("12345")
except Exception as e:
    # The classic. Catches everything, handles nothing specifically.
    logger.error(f"Something went wrong: {e}")
```

```java
// Java tried to fix this with checked exceptions.
// In theory: you declare what can be thrown, callers must handle it.
// In practice:
public UserData processUser(String userId) throws Exception {
    // "throws Exception" — the Java equivalent of giving up.
    // Checked exceptions were a good idea that failed in practice because
    // it's just too easy to declare "throws Exception" and move on.
    try {
        Config config = loadConfig("settings.yaml");
        Database db = connectToDatabase(config.getDbUrl());
        return db.query(userId);
    } catch (Exception e) {
        // Swallow it, wrap it, rethrow it — pick your adventure.
        throw new RuntimeException("Failed to process user", e);
        // At least we wrapped it with context. Many don't even do that.
    }
}
```

Here's the thing: you _can_ get good error handling with exceptions. If you keep functions small and focused, let exceptions propagate intentionally, annotate them with context at each level, and specify what can be thrown — you can get a similar effect to what result-based systems give you.

But it doesn't work well in practice. The language makes it too easy to catch `Exception` and move on. Too easy to forget that a line of code can throw. Too easy to accidentally swallow an error in a `finally` block. The path of least resistance is `catch (Exception e)`, and that's what people reach for when they're tired or in a hurry.

To be fair — there are large, well-run systems with excellent exception-based error handling. Spring's exception hierarchy, Python's ecosystem conventions, C#'s async exception patterns — these work in practice at real organizations with real discipline. The issue isn't that exceptions _can't_ work. It's that the failure mode is silent: when discipline slips, exceptions fail by hiding errors, while result types fail by being annoying. I'd rather have annoying.

#### The Silent Swallow and the Invisible Rethrow

The most insidious exception anti-patterns aren't the ones that crash your program — they're the ones that silently hide failures:

```python
# The silent swallow — errors disappear into the void
def sync_user_data(user_id: str):
    try:
        remote = fetch_remote_profile(user_id)
        local = db.get_user(user_id)
        db.update_user(user_id, merge(local, remote))
    except Exception:
        pass  # "It's fine, we'll get it next time"
        # Narrator: they did not get it next time.
        # Meanwhile, user data is silently stale and nobody knows.
```

```python
# The finally footgun — cleanup code that masks the real error
def transfer_funds(from_acct, to_acct, amount):
    conn = db.connect()
    try:
        conn.execute("UPDATE accounts SET balance = balance - %s WHERE id = %s",
                     amount, from_acct)
        conn.execute("UPDATE accounts SET balance = balance + %s WHERE id = %s",
                     amount, to_acct)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()  # What if close() throws?
        # The original exception is replaced by the close() exception.
        # Your logs now show "connection close error" instead of
        # "insufficient funds" or "account not found."
```

These aren't hypothetical — they're patterns you'll find in production codebases everywhere. The `except: pass` pattern is so common that linters have specific rules to flag it. The `finally` masking problem is subtle enough that experienced developers still get bitten by it.

#### The Inspectability Problem

There's a deeper issue beyond syntax: with exceptions, **you can't easily tell what a function might throw just by looking at its signature**. Consider:

```python
def get_user_profile(user_id: str) -> UserProfile:
    ...
```

What can go wrong here? `HTTPError`? `TimeoutError`? `JSONDecodeError`? `KeyError`? You have no idea without reading the implementation — and every implementation it calls, recursively. Catching the right exception is guesswork unless you've memorized the entire call tree or the docs happen to be thorough (they usually aren't).

Compare this to how Absl and Rust handle the same problem:

```cpp
// Absl: the return type tells you this can fail,
// and you handle it with a known set of canonical codes
absl::StatusOr<UserProfile> GetUserProfile(absl::string_view user_id);

// The caller knows exactly what to check:
auto result = GetUserProfile(user_id);
if (absl::IsNotFound(result.status())) { /* 404 */ }
else if (absl::IsUnavailable(result.status())) { /* retry */ }
else if (!result.ok()) { /* catch-all for everything else */ }
```

```rust
// Rust: the error type is in the signature, and match is exhaustive
fn get_user_profile(user_id: &str) -> Result<UserProfile, ProfileError>;

// The compiler tells you what to handle:
match get_user_profile(user_id) {
    Ok(profile) => use_profile(profile),
    Err(ProfileError::NotFound { .. }) => return_404(),
    Err(ProfileError::Timeout { .. }) => retry(),
    Err(e) => return Err(e.into()),  // propagate the rest
}
// Add a new variant to ProfileError? The compiler flags every
// match statement that doesn't handle it. Try that with exceptions.
```

With Absl, you have 17 canonical codes — a known, finite set. With Rust, you have typed enums that the compiler enforces exhaustively. In both cases, the failure modes are **visible in the function signature** and **inspectable with simple control flow** — an `if` tree on status codes, or a `match` on enum variants. No guessing, no reading source code three layers deep, no hoping the docs are accurate.

Exceptions invert this: the failure modes are invisible, the control flow is implicit, and handling them correctly requires knowledge the language doesn't surface. Java's checked exceptions were an attempt to fix this — force the signature to declare what can be thrown — but they failed in practice because `throws Exception` is too easy an escape hatch.

Exceptions don't explicitly annotate what can fail. They create invisible control flow. And they make it trivially easy to violate error domain boundaries — an uncaught exception can tear down your entire process when all you wanted was to fail a single request.

### 3.3 Go: Right Philosophy, Wrong Ergonomics

Go made a deliberate choice: errors are values, not exceptions. You return them explicitly and check them explicitly. This is philosophically correct.

The problem is the ergonomics.

```go
func processOrder(ctx context.Context, orderID string) (*Order, error) {
    user, err := getUser(ctx, orderID)
    if err != nil {
        return nil, fmt.Errorf("getting user for order %s: %w", orderID, err)
    }

    inventory, err := checkInventory(ctx, user.Items)
    if err != nil {
        return nil, fmt.Errorf("checking inventory: %w", err)
    }

    payment, err := processPayment(ctx, user.PaymentMethod, inventory.Total)
    if err != nil {
        return nil, fmt.Errorf("processing payment: %w", err)
    }

    order, err := createOrder(ctx, user, inventory, payment)
    if err != nil {
        return nil, fmt.Errorf("creating order: %w", err)
    }

    err = sendConfirmation(ctx, user.Email, order)
    if err != nil {
        return nil, fmt.Errorf("sending confirmation: %w", err)
    }

    return order, nil
}
// Five operations. Fifteen lines of error checking.
// The actual logic is buried under the boilerplate.
```

Every operation gets three lines: call, check, return. The `if err != nil` pattern is so pervasive that it drowns out the actual business logic. Of the ~20 lines in this function body, only about 5 are doing real work.

This is so widely acknowledged that the Go team spent seven years trying to find better syntax for it. [They tried three different proposals](https://go.dev/blog/error-syntax) and in June 2025, officially announced they're done — no new error handling syntax is coming. The verbosity is a recognized problem that even the language designers couldn't solve without breaking Go's core philosophy.

Go has a single, universal `error` interface, which is both its strength (simplicity, standardization) and its limitation (no built-in way to carry structured error information without extra libraries). Rob Pike's ["Errors are values"](https://go.dev/blog/errors-are-values) essay makes the case that you can program with errors creatively, and he's right — but the default experience is still verbose.

#### Error Wrapping and Inspection: Go's Afterthought That Helps

Go 1.13 added machinery that the original error design was missing: `fmt.Errorf` with `%w` for wrapping errors (you can see it in the example above), and `errors.Is()` / `errors.As()` for unwrapping them:

```go
import "errors"

var ErrNotFound = errors.New("not found")
var ErrPermissionDenied = errors.New("permission denied")

func getUser(ctx context.Context, id string) (*User, error) {
    row, err := db.QueryRow(ctx, "SELECT ...", id)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            // Wrap with a domain-specific sentinel error
            return nil, fmt.Errorf("user %s: %w", id, ErrNotFound)
        }
        return nil, fmt.Errorf("querying user %s: %w", id, err)
    }
    return scanUser(row)
}

// Callers can now inspect the error chain:
user, err := getUser(ctx, "12345")
if errors.Is(err, ErrNotFound) {
    // Handle "not found" specifically — return 404, create default, etc.
    http.Error(w, "User not found", http.StatusNotFound)
} else if errors.Is(err, ErrPermissionDenied) {
    http.Error(w, "Forbidden", http.StatusForbidden)
} else if err != nil {
    http.Error(w, "Internal error", http.StatusInternalServerError)
}

// errors.As lets you extract a specific error type from the chain:
var pgErr *pgconn.PgError
if errors.As(err, &pgErr) {
    log.Printf("Postgres error code: %s", pgErr.Code)
}
```

This is a significant improvement over Go's original "errors are just strings" story. `%w` wrapping preserves the error chain so callers can inspect _what_ failed without parsing messages. `errors.Is()` walks the chain looking for a specific sentinel value; `errors.As()` walks it looking for a specific type.

But it's still opt-in and convention-driven. Nothing stops you from using `%v` instead of `%w` (which discards the chain), or from skipping sentinel errors entirely and just returning `fmt.Errorf("something broke")`. The machinery exists, but the language doesn't push you toward using it — and in practice, a lot of Go code still doesn't.

The Go experience reinforces a key point: **error handling is an organizational and tooling problem, not just a language problem.** The Go team decided that better IDE support, linters, and AI assistance are more promising paths than syntax changes.

### 3.4 Absl Status: Engineering Standardization Done Right

Google's [C++ Style Guide](https://google.github.io/styleguide/cppguide.html#Exceptions) famously bans exceptions. The reasoning is practical, not ideological: in a codebase with hundreds of millions of lines of C++ that was never designed for exception safety, introducing exceptions would be a liability, not a feature. So Google needed an alternative — and [`absl::Status`](https://abseil.io/docs/cpp/guides/status) is what they built.

It's the primary mechanism for error handling across the entire C++ codebase. A result type with a fixed set of [canonical error codes](https://abseil.io/docs/cpp/guides/status-codes) that map directly to [gRPC status codes](https://grpc.io/docs/guides/status-codes/) — the same codes used across all Google services.

```cpp
#include "absl/status/status.h"
#include "absl/status/statusor.h"

// StatusOr<T>: either a value of type T, or an error Status.
// Similar to Rust's Result<T, E> or C++23's std::expected.
absl::StatusOr<UserProfile> GetUserProfile(absl::string_view user_id) {
    auto db_result = database->Lookup(user_id);
    if (!db_result.ok()) {
        // Propagate with added context
        return absl::NotFoundError(
            absl::StrCat("User profile not found for id: ", user_id));
    }

    auto parsed = ParseProfile(db_result.value());
    if (!parsed.ok()) {
        return absl::InternalError(
            absl::StrCat("Failed to parse profile for id: ", user_id));
    }

    return parsed.value();
}
```

The canonical error codes are the same 17 codes used by gRPC everywhere. The most commonly used ones:

| Code                  | When to Use                                        |
| --------------------- | -------------------------------------------------- |
| `OK`                  | Success                                            |
| `INVALID_ARGUMENT`    | Client sent bad input (regardless of system state) |
| `NOT_FOUND`           | Requested entity doesn't exist                     |
| `ALREADY_EXISTS`      | Tried to create something that already exists      |
| `PERMISSION_DENIED`   | Caller lacks permission                            |
| `UNAUTHENTICATED`     | Caller's identity cannot be verified               |
| `RESOURCE_EXHAUSTED`  | Quota or resource limit hit                        |
| `FAILED_PRECONDITION` | System not in required state                       |
| `UNAVAILABLE`         | Service temporarily unavailable (retry)            |
| `INTERNAL`            | Something broke inside (the catch-all)             |
| `UNIMPLEMENTED`       | Operation not supported                            |
| `DEADLINE_EXCEEDED`   | Operation timed out                                |

The full list of all 17 codes is defined in [`google.rpc.Code`](https://github.com/googleapis/googleapis/blob/master/google/rpc/code.proto).

What makes Absl Status powerful isn't just the type — it's the macros and idioms that make it ergonomic:

```cpp
// RETURN_IF_ERROR: propagate errors with one line
absl::Status ProcessBatch(const std::vector<Item>& items) {
    RETURN_IF_ERROR(ValidateItems(items));
    RETURN_IF_ERROR(ReserveCapacity(items.size()));
    RETURN_IF_ERROR(WriteToDB(items));
    return absl::OkStatus();
}

// ASSIGN_OR_RETURN: unwrap StatusOr or propagate the error
absl::StatusOr<Report> GenerateReport(absl::string_view report_id) {
    ASSIGN_OR_RETURN(auto config, LoadConfig(report_id));
    ASSIGN_OR_RETURN(auto data, FetchData(config));
    ASSIGN_OR_RETURN(auto report, BuildReport(data));
    return report;
}
```

Compare that `ASSIGN_OR_RETURN` pattern with Go's three-line `if err != nil` blocks — same concept, dramatically less noise. The happy path reads clean, and every line that can fail is visibly annotated with a macro.

The origin story matters here. The Absl Status approach was codified in a concise internal design document (attributed to Sanjay Ghemawat) that laid out how Status should work across C++ libraries and teams. It's the kind of clear, opinionated one-pager that makes org-wide adoption actually happen. This is an artifact of Google's engineering culture — the same discipline that shaped not just Absl but also Go's error philosophy: errors are values, handle them explicitly, standardize the interface.

Because `absl::Status` maps to gRPC codes, errors propagate cleanly across service boundaries. A `NOT_FOUND` returned from a storage layer becomes a `NOT_FOUND` in the gRPC response — no translation needed. This is genuinely amazing when you're operating at the scale of hundreds of internal services calling each other.

**The con:** `INTERNAL` becomes a catch-all. When people don't know what error code to use, they reach for `INTERNAL`, which defeats the purpose of having canonical codes. It's the "throws Exception" of the Status world. This is a discipline problem, not a design problem — but it's common enough to mention.

One thing worth calling out: the canonical codes implicitly encode _retryability_. `UNAVAILABLE` means "try again." `INVALID_ARGUMENT` means "don't bother — the input is wrong no matter how many times you send it." `DEADLINE_EXCEEDED` means "it might work if you give it more time." This isn't accidental — it's error domains applied to the _response_, not just the failure. Knowing whether an error is transient or permanent, and whether retrying is safe, is often more valuable than knowing exactly what went wrong. Good error codes should tell the caller what to _do_, not just what happened. This isn't just conceptual — it maps directly to how real infrastructure behaves. Load balancers, service meshes, and retry middleware all consume these codes to decide whether to retry, reroute, or fail fast.

**The other con:** This approach fundamentally only works inside of Google, or inside organizations that have fully standardized on Absl. It's not a universal solution — it's a demonstration of what standardization _can_ achieve when you have the organizational will to enforce it.

### 3.5 Rust: So Close to Perfect

I'm going to spend more time on Rust than the other approaches — partly because it's my favorite, partly because the error handling ecosystem has more moving pieces worth explaining. Take that bias as disclosed.

Rust is my favorite approach to error handling. It gets more right than any other language I've worked with. But it has real issues that are worth being honest about.

One thing Rust gets fundamentally right: the distinction between `panic` and `Result` _is_ an error domain boundary. Panics are for programmer bugs — invariant violations, logic errors, things that should never happen. Results are for expected failures — network timeouts, missing files, bad input. Panics have process-level blast radius; Results have request-level blast radius. That's the error domain principle built directly into the language's type system.

#### Result and the `?` Operator: The Gold Standard

```rust
use anyhow::{Context, Result};

fn process_order(order_id: &str) -> Result<Order> {
    let user = get_user(order_id)
        .context("Failed to look up user")?;              // ? = propagate or unwrap
    let inventory = check_inventory(&user.items)
        .context("Inventory check failed")?;
    let payment = process_payment(&user.payment, inventory.total)
        .context("Payment processing failed")?;
    let order = create_order(&user, &inventory, &payment)
        .context("Order creation failed")?;
    send_confirmation(&user.email, &order)
        .context("Failed to send confirmation")?;
    Ok(order)
}
```

Look at that. Five fallible operations, each on one line, each with context, and the happy path reads top to bottom like a recipe. The `?` operator is Rust's equivalent of Absl's `ASSIGN_OR_RETURN` — but it's built into the language, not a macro.

The `?` operator says: "if this is an error, return it from this function; if it's a value, unwrap it and keep going." It visibly annotates the error path while optimizing for the happy path. It's concise without being invisible.

It does trip up newcomers — `?` is syntactic sugar that hides real control flow, and sometimes people apply it too liberally for errors they could (and should) handle locally. But as a default for propagation, it's the best ergonomics I've seen in any language.

#### anyhow: Type-Erased Errors for Applications

[`anyhow`](https://github.com/dtolnay/anyhow) is Rust's closest equivalent to `absl::Status`. It provides a single, type-erased error type that any error can convert into, plus excellent context annotation:

```rust
use anyhow::{Context, Result};
use std::fs;

fn load_config(path: &str) -> Result<Config> {
    let content = fs::read_to_string(path)
        .with_context(|| format!("Failed to read config file: {}", path))?;

    let config: Config = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse config from: {}", path))?;

    Ok(config)
}

// When this fails, you get something like:
// Error: Failed to read config file: /etc/myapp/config.json
//
// Caused by:
//     No such file or directory (os error 2)
```

That error output is _exactly_ what you want during an incident. Human-readable, contextual, actionable. The `.context()` and `.with_context()` methods let you build up a chain of "what was happening when this failed" annotations — which is far more useful for debugging than a raw stack trace.

This is the best compromise approach for application code. You lose the ability to programmatically match on specific error types, but you gain ergonomics and excellent debugging output. For applications that are stitching libraries together, that's usually the right trade-off.

#### thiserror: Structured Errors for Libraries

When you _do_ need callers to distinguish between error types — i.e., you're writing a library — [`thiserror`](https://github.com/dtolnay/thiserror) provides a clean declarative interface:

```rust
use thiserror::Error;

#[derive(Error, Debug)]
pub enum StorageError {
    #[error("Record not found: {key}")]
    NotFound { key: String },

    #[error("Permission denied for table: {table}")]
    PermissionDenied { table: String },

    #[error("Connection to database failed")]
    ConnectionFailed(#[from] std::io::Error),

    #[error("Query timed out after {timeout_ms}ms")]
    Timeout { timeout_ms: u64 },
}

// Callers can now match on specific variants:
match storage.get("user:123") {
    Ok(data) => process(data),
    Err(StorageError::NotFound { .. }) => create_default_user(),
    Err(StorageError::Timeout { .. }) => retry_with_backoff(),
    Err(e) => return Err(e.into()),  // propagate everything else
}
```

The `#[error(...)]` macro generates `Display` implementations. The `#[from]` attribute generates `From` implementations for automatic conversion. It's minimal boilerplate for a fully typed error hierarchy.

The common wisdom — `thiserror` for libraries, `anyhow` for applications — is a good starting point. In practice, many projects use both: `thiserror` at their public API boundaries and `anyhow` internally.

#### The Error Domain Conversion Problem

Here's where Rust's error handling gets messy. Rust has `Result<T, E>` as a standard, but there's no standard _error type_. Every library defines its own. This means you constantly need to convert between error domains:

```rust
// Your function calls three libraries. Each has its own error type.
fn do_stuff() -> Result<(), MyError> {
    let data = reqwest::get("https://api.example.com")  // reqwest::Error
        .await?
        .json::<Data>()                                   // reqwest::Error
        .await?;

    let parsed = serde_json::from_value(data.payload)?;   // serde_json::Error

    std::fs::write("output.txt", parsed)?;                // std::io::Error

    Ok(())
    // Three different error types. All need to convert to MyError.
    // Either via From impls, or by using anyhow to erase them all.
}
```

This is the fundamental unsolved problem in Rust's error story. The standard library gives you `Result` and the `Error` trait, but no common concrete error type. So every boundary between your code and a library — or between two libraries — requires explicit error conversion.

Within a file or module, it's important to be very clear about which `Result` you're talking about. Is it `anyhow::Result`? `std::io::Result`? Your custom `Result<T, MyError>`? I actually think Google's namespacing conventions have something going for them here — being explicit about types makes code read-optimized. You can drop into any file and immediately know what you're dealing with.

The `?` operator and `From` trait handle much of this conversion automatically, and `anyhow` erases the problem entirely for application code. But the underlying design tension remains: ad-hoc error domain conversion, done inconsistently across a codebase, makes code harder to read and reason about. It should be handled systematically — with a clear strategy — not sprinkled in as an afterthought.

#### `From` Implicit Conversion: Useful but Watch Your Step

The `From` trait enables implicit error conversion with `?`, which is powerful but creates real risks when used carelessly.

**The missing conversion** — the frustrating compiler error:

```rust
// You write what looks perfectly reasonable:
fn read_config() -> Result<Config, MyError> {
    let content = std::fs::read_to_string("config.json")?;
    //                                                    ^ ERROR:
    // the trait `From<std::io::Error>` is not implemented for `MyError`

    // You need to either:
    // 1. Add: impl From<std::io::Error> for MyError { ... }
    // 2. Use thiserror's #[from] attribute
    // 3. Map the error manually: .map_err(MyError::Io)?
    // 4. Use anyhow and sidestep the whole thing
    Ok(toml::from_str(&content)?)
}
```

This is confusing for newcomers. "I'm returning an error... why can't I use `?`?" The answer is that Rust needs an explicit conversion path between error types, which is type-safe and correct but can feel like fighting the compiler when you're just trying to propagate an error.

**Context loss through careless conversion** — the common production footgun:

```rust
#[derive(Error, Debug)]
pub enum ServiceError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("unexpected: {0}")]
    Other(String),
}

// v1: careful conversion, typed error preserved
fn get_user(id: &str) -> Result<User, ServiceError> {
    let user = sqlx::query_as("SELECT ...")
        .bind(id)
        .fetch_one(&pool)
        .await?;  // sqlx::Error -> ServiceError::Database ✓
    Ok(user)
}

// v2: someone refactors through an anyhow layer
fn get_user_v2(id: &str) -> Result<User, ServiceError> {
    let user = some_anyhow_helper(id)  // returns anyhow::Error
        .await
        .map_err(|e| ServiceError::Other(e.to_string()))?;
    // The sqlx::Error inside the anyhow::Error just got
    // flattened to a string. The typed error is gone.
    // Downstream code matching on ServiceError::Database?
    // Silently stops working. No compiler warning.
    Ok(user)
}
```

This is the most common `From`-related footgun in practice. Someone wraps a typed error into `anyhow::Error` or `String` during a refactor, and downstream match arms silently stop firing. The types all check out. The code compiles. You just lost your error domain boundary — the caller can no longer distinguish "database timeout, safe to retry" from "unexpected failure, don't retry." That's not a cosmetic problem; it's a blast radius problem.

To be fair — flattening errors is sometimes exactly what you want. If you're crossing an API boundary and the caller has no business knowing about your internal database schema, converting `sqlx::Error` into `ServiceError::Other("storage unavailable")` is good hygiene — it's the error domain principle in action. The problem isn't flattening itself. It's _accidental_ flattening: when context gets stripped not because someone made a design decision, but because someone used `.to_string()` or a blanket `From` impl without thinking about what information the caller needs. Intentional recontextualization is an API design choice. Accidental context loss is a bug that the compiler won't catch.

**Unexpected implicit conversion** — the rarer but scarier case:

When you have multiple `From` implementations in scope — especially blanket impls or long chains of conversions — it's possible for `?` to route an error through a conversion path you didn't intend. The compiler picks a valid path, but not necessarily the path you expected. The error arrives at the caller with the wrong type, the wrong context, or both. This is hard to trigger accidentally in small codebases, but in larger systems with many error types and `From` impls accumulating over time, it becomes a real risk. The failure mode is particularly insidious: the code compiles, tests pass (because tests rarely exercise the exact error conversion path), and the bug surfaces at 2 AM when a specific error takes a wrong turn and causes a handler to make the wrong decision.

Both of these are fundamentally **error domain violations**. The whole point of typed errors is that they carry meaning across boundaries — "this is a retryable database failure" vs. "this is a permanent validation error." When a conversion silently strips that meaning, you've breached the domain boundary just as surely as an uncaught exception unwinding past your error handler. The type system gave you a wall; the `From` impl put a hole in it.

The practical lesson: **treat `From` implementations as API contracts, not convenience methods.** Review them in code review the way you'd review a public function signature. Be intentional about what context survives the conversion. And when you're stitching together libraries with different error types, choose your conversion strategy deliberately — don't let it accumulate by accident.

#### `unwrap()`: Fine for Development, Keep It Out of Production

```rust
// During development: go for it
let config = load_config().unwrap();

// The argument for unwrap:
// 1. Fast iteration — you know the shape of the code isn't final
// 2. Sometimes you've already checked: if items.is_empty() { return; }
//    items.first().unwrap()  // We KNOW this is safe
// 3. Truly impossible cases: "this regex is hardcoded, it's always valid"
//    let re = Regex::new(r"^\d+$").unwrap();

// But in production code: use expect() at minimum
let config = load_config().expect("Config file must exist at startup");
// At least when it panics, you get a message explaining the invariant.
```

I'm a fan of `unwrap()` during development. It keeps you moving. But it should not make it into production code. Use `expect()` with a message explaining _why_ you believe this can't fail, or better yet, handle the error properly.

There are edge cases where an `unwrap()` is genuinely safe — you've already validated the precondition, or the value is hardcoded — and accepting the risk of a crash in those cases is a reasonable engineering decision. But these should be the exception, explicitly justified, not the default.

#### The Debugging Pain: Stack Traces in Rust Are Rough

Rust's error handling takes a real hit when it comes to debugging. Because errors are values propagated via `return` rather than exceptions with captured stack traces, you don't automatically get a trace of where the error originated and how it traveled up the call stack.

When you do get a stack trace (via `RUST_BACKTRACE=1` or anyhow's backtrace capture), it's often aggressively mangled — full of async runtime internals, monomorphized generic names, and framework boilerplate that obscures the actual application code.

This is where human-readable context annotations become critical. The `.context()` chain that anyhow provides isn't just nice to have — it's your _primary_ debugging tool in Rust. You're building a semantic trace of what was happening, rather than relying on a mechanical trace of where code executed.

```txt
// A raw Rust backtrace might give you:
//   0: core::result::Result<T,E>::unwrap
//   1: tokio::runtime::task::harness::Harness<T,S>::poll
//   2: <futures_util::future::try_future::MapErr<Fut,F> as ...>
//   ... 47 more frames of runtime internals ...

// An anyhow context chain gives you:
// Error: Failed to generate monthly report for client "Acme Corp"
//
// Caused by:
//     0: Failed to fetch revenue data for Q4 2025
//     1: Database query timed out after 30000ms
//     2: Connection refused (os error 111)
//
// Which one helps you fix the problem?
```

For larger systems, this is also where distributed tracing frameworks (spans, traces, OpenTelemetry) pick up where language-level error handling leaves off. Annotating your request processing with spans — "this is the user authentication step," "this is the database query" — gives you the application-level journey that neither stack traces nor error chains fully capture. But that's an engineering and organizational discipline issue, not a language issue.

#### What Rust Gets Right Despite All This

Here's what's remarkable: Rust manages to standardize on `Result` and have genuinely great error handling ergonomics _despite_ not fully solving the error domain problem at the standard library level.

The `?` operator is the gold standard for annotating fallible operations. `anyhow` and `thiserror` together cover the application/library split cleanly. The compiler _forces_ you to handle errors — you can't accidentally ignore a `Result` without the compiler warning you.

The ecosystem arrived at good conventions through community consensus rather than top-down standardization, and that's impressive. It's not as clean as Absl's organization-wide mandate, but it works remarkably well for an open ecosystem.

---

## 4. Closing Thoughts

### 4.1 Error Domains are Everything

Everything in this article flows from one question: **when something fails, what else breaks?**

If your answer is "just this request" — you're in good shape. If it's "maybe the whole service" or "we're not sure" — that's the real problem to solve, regardless of which language or error handling library you're using.

If you get the blast radius right, everything else is details.

One caveat: these principles are most battle-tested in long-running services and servers. If you're building a CLI, a game engine, or an embedded system, the boundaries look different — Erlang built an entire philosophy around "let it crash" and it works beautifully. The thinking is the same; the blast radius just changes shape.

### 4.2 Mechanics Help, Discipline Decides

Your error handling is only as good as the engineers and the organization behind it. No amount of clever language features will save you from:

- Engineers who catch all exceptions and log nothing
- Error types that are all `INTERNAL` or `Other(String)`
- Missing context in error messages because adding it was too much work
- No shared conventions across the team

But good machinery _does_ make it easier to do the right thing. A type system that forces you to handle errors (Rust) is better than one that lets you ignore them (C). Ergonomic macros (`RETURN_IF_ERROR`, `?`) are better than three lines of boilerplate per check. Standard error codes that propagate across service boundaries (Absl + gRPC) are better than every team inventing their own.

**Make it easy to do the right thing. Make the wrong thing hard.**

### 4.3 My Recommendations

**Absl Status** is still my favorite, but mostly for standardization reasons. The power isn't in the `Status` type itself — it's in the fact that every C++ engineer at Google speaks the same error language. The canonical codes, the macros, the propagation across gRPC boundaries — it all works because of organizational commitment. It's a proof of what's possible when an entire organization agrees on error handling conventions.

**Rust** gets very, very close — and in some ways exceeds Absl in ergonomics. The `?` operator is more elegant than macros. `anyhow` + `thiserror` is the right answer for most Rust projects. But the lack of a standard error type in the standard library means the ecosystem relies on convention rather than mandate, and that means inconsistency across library boundaries.

**Exceptions** are a reality many of us live with. You can absolutely apply these principles to Java, Python, or any exception-based language: keep functions small and focused, let exceptions propagate intentionally, annotate with context, specify what can be thrown, and resist the urge to `catch (Exception e)`. In theory, you can get a similar effect to result-based systems. In practice, it rarely works out because the language makes the wrong thing too easy and the right thing too tedious. But if exceptions are what you've got, the principles still apply.

**In any language**, the same fundamentals hold: think about error domains, contain your blast radius, annotate with human-readable context, and invest more energy in organizational conventions than in designing the perfect error type hierarchy.

The best error handling code I've seen wasn't written in any particular language. It was written by teams that agreed on conventions, reviewed error handling in code reviews, and treated "what happens when this fails" as a first-class design question rather than an afterthought.

---

If this post helped you think differently about error handling — or gave you ammunition for your next code review — consider [buying me a coffee](https://ko-fi.com/nevzheng). ☕

---

## 5. References

- [Will Larson: "Describing fault domains"](https://lethain.com/fault-domains/) — The best bridge between hardware fault domains and software architecture. Defines fault domains, fault levels, fault hierarchies, and failure policies (redundant, ignorable, cascade). Practical and readable.

- [Google C++ Style Guide: Exceptions](https://google.github.io/styleguide/cppguide.html#Exceptions) — Google's rationale for banning C++ exceptions. The practical reasoning — not ideological, just acknowledging the reality of a massive codebase never designed for exception safety — is what led to Absl Status.

- [Abseil Status User Guide](https://abseil.io/docs/cpp/guides/status) — The official guide to `absl::Status` and `absl::StatusOr<T>`. Covers the core patterns for result-based error handling in C++ as practiced at Google.

- [Abseil: Choosing Canonical Error Codes](https://abseil.io/docs/cpp/guides/status-codes) — Practical guidance on picking the right error code. Especially useful for understanding the subtle distinctions between `FAILED_PRECONDITION`, `ABORTED`, and `UNAVAILABLE`.

- [gRPC Status Codes](https://grpc.io/docs/guides/status-codes/) — The canonical 17 error codes used across all gRPC services. These are the same codes Absl uses, and they propagate across service boundaries — which is the key insight.

- [`google.rpc.Code` proto definition](https://github.com/googleapis/googleapis/blob/master/google/rpc/code.proto) — The authoritative definition of the canonical error codes as a protobuf enum. Reading the comments on each code is worthwhile — they document the exact semantics and edge cases.

- [anyhow crate (GitHub)](https://github.com/dtolnay/anyhow) — The type-erased error library for Rust applications. The README examples of `.context()` and `.with_context()` demonstrate exactly the kind of human-readable error annotation I advocate for.

- [thiserror crate (GitHub)](https://github.com/dtolnay/thiserror) — The derive macro for creating custom error types in Rust. The companion to anyhow — use thiserror for library APIs where callers need to match on error variants.

- [Go Blog: "Errors are values"](https://go.dev/blog/errors-are-values) — Rob Pike's influential essay on treating errors as programmable values in Go. The core philosophy is sound even if the ergonomics are debatable.

- [Go Blog: "Working with Errors in Go 1.13"](https://go.dev/blog/go1.13-errors) — The official introduction of `errors.Is()`, `errors.As()`, and `fmt.Errorf` with `%w` wrapping. The machinery that turned Go's "errors are just strings" story into something you can actually inspect programmatically.

- [Go Blog: "On syntactic support for error handling"](https://go.dev/blog/error-syntax) (June 2025) — The Go team's official announcement that they will not pursue new error handling syntax, after three failed proposals over seven years. A fascinating case study in language design trade-offs and the limits of syntax changes.

- [GreptimeDB: "Error Handling for Large Rust Projects"](https://greptime.com/blogs/2024-05-07-error-rust) — An excellent deep dive into the practical pain of Rust stack traces and the "stacked error" pattern as an alternative. Shows how a real production project solved the debugging problem.

- [Google API Design Guide: Errors (AIP-193)](https://google.aip.dev/193) — Google's API design guidelines for error handling. Demonstrates how the canonical error codes and `google.rpc.Status` are used at the API level, with practical guidance on error messages, partial errors, and detail payloads.
