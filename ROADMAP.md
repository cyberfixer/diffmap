# diffmap Roadmap

**Goal:** make code review feel as close as possible to working in an IDE, but focused on the changes, so the reviewer never gets lost.

**What diffmap does today:** you give it two git refs (CLI) or open a GitLab merge request (service). It finds the changed lines, works out which function, method, class or template each line belongs to, finds who uses them, and shows it all as an interactive map: changed files as cards, callers outside the change shown in full, arrows to the exact lines. On GitLab you can comment, reply, approve and mark functions as viewed.

---

## Done

### 40. TypeScript: where a type is used — DONE
- Only calls counted as usages, so a changed `interface`, `enum` or class used as a type showed none, and `type X = ...` was not a symbol at all (its change went to "top-level code"; the rest of roadmap item 4).
- Type aliases are symbols (`type`). A new kind of link, `uses-type`, says who writes a type: a parameter or return type, a field, inside a generic (`Promise<Order[]>`), `extends` / `implements`, and an enum through its members (`Kind.Online`). A type this diff removed that is still written is a use of removed code.
- It is followed one way only: from a changed type to who uses it, never from a changed function to the types it mentions, so the map does not fill up with every function's parameter types.
- The page tags such usages "type" and says "Nothing uses this type." when there are none.
- nestjs/nest: calls unchanged (8,688), 6,182 type uses added; linking the whole repo 8.6 s -> 9.8 s. Two real changes: 2 and 16 type links more on the map.

### 39. Objective-C calls Swift by the name Objective-C sees — DONE
- Fahad's case: `@objc(presentThread:) func presentView(_ thread: Thread)` is called from Objective-C as `[list presentThread:thread]` and `@selector(presentThread:)`. Objective-C's methods were named the way Swift sees them (35), but Swift's were not named the way Objective-C sees them, so these calls met nothing (and `[list presentView:thread]`, which Objective-C cannot write, was linked).
- A Swift declaration that Objective-C can be seen to reach (`@objc`, `@IBAction`, `@IBOutlet`, `@NSManaged`..., in an `@objcMembers` class, an `@objc extension` or an `@objc protocol`; not `@nonobjc`) now has the names Objective-C calls it by (`objcNames` in swift.ts): the one `@objc(..)` gives, else the selector the Swift compiler makes, by its rules (`getObjCSelector` in lib/AST/Decl.cpp, prepositions from lib/Basic/PartsOfSpeech.def): `present(view:)` -> `presentWithView:`, `move(to:)` -> `moveTo:`, `init(name:)` -> `initWithName:`, `present(_:animated:)` -> `present:animated:`, `throws` -> `..error:` / `..AndReturnError:`, before any closures at the end (`fetch(id:completion:)` -> `fetchWithId:error:completion:`, errorParameterIndex in lib/Sema/TypeCheckDeclObjC.cpp), `async` -> `..completionHandler:`. Backticks are left out (``h(`default`:)`` -> `hWithDefault:`). A property: its getter and `setName:`. A type: `@objc(MYStore) class Store` is `MYStore` in Objective-C code.
- Objective-C calls and `@selector(..)`s reach such code by those names only, and a `@selector` must match a method's whole selector. One with arguments that is none of the caller's own reaches such Swift code when the file can see just one, as a message to an object of unknown type would; a selector without arguments, or one naming Objective-C's own methods, links as before. A call by the Objective-C name of Swift code the change removes is a call into removed code. Swift calls are left as they were.
- On the page, an Objective-C usage underlines the word it writes (`presentThread` in `[list presentThread:thread]`, `setTitle`, `initWithName`, `MYStore`; `objcNames` of a node), so a click on it goes to `presentView` like any usage. The symbol's own name is tried first: every other row is underlined as before.
- Not followed: the selector of an `override` without a name (it is the overridden method's, often a system one Swift renamed on import), methods that are `@objc` only because they fulfil an `@objc` protocol or are in another extension of an `@objcMembers` class, `NS_SWIFT_NAME`, and headers.
- `scripts/compare-links.ts` on wikimedia/wikipedia-ios (1,598 Swift, 165 Objective-C files) and signalapp/Signal-iOS (2,720 Swift, 34 Objective-C files): links from Objective-C 1,538 -> 1,623 (88 new, 3 gone) and 127 -> 170 (44 new, 1 gone); Swift, C, JavaScript, Python and Ruby links the same, link for link. All 132 new links read against the source: 130 right, 2 reach `Themeable.apply(theme:)`, the `@objc` protocol requirement the called class's own method fulfils. The 4 gone were wrong: a block parameter called `update` tied to Swift's `update(withSummary:)` (2), a `@selector` with other labels, a class method of another class.

### 38. A definition is shown where the parser says its name is — DONE
- 35 found a symbol's line by looking for its name in the text of its first 12 lines. An attribute that holds the name came first: `@objc(reloadThreads:)` before `func reloadThreads`, `@JvmName("load")` before `fun load`, and so did a one-line `@objc(clearAll) func clearAll()` for the underline. In "Changes only" the attribute line was opened and highlighted while the `func` line stayed folded (Fahad's report; before 35 it was every `@objc` on a line of its own).
- The parsers now say where a symbol's name is written (`range.name` of a symbol, `nameAt` of a node: line and column). tree-sitter takes it from the definition's name, passing over attributes, annotations, modifiers and comments (`nameNode` in engine.ts); TypeScript from the declaration's name, after its decorators. The page selects, scrolls to, flashes and underlines that place, and the panel's `file:line` says it. Without a place from the parser (Angular templates), the name is looked for in the text as before.
- An "implements" usage is listed on the line with the implementing method's name, not on its `@objc` or `override` line.
- Checked in a browser on a Swift and Objective-C change, before and after, in "Changes only" and "Whole file": picked from the list, from a usage, with Back / Forward and the panel's `file:line`; a long file that starts collapsed; a removed method; a caller outside the diff; a protocol's implementation. Before, 10 of the 15 ways picked or underlined the attribute; now none.

### 37. Xcode's colours — DONE
- An **Xcode** button next to Auto / Light / Dark colours the code like Xcode's built-in Default (Light) or Default (Dark), whichever the page shows. Remembered in the browser (`diffmap:style`) and applied before the page paints, like the theme; on the review pages of the CLI and of the service.
- Every value is from the theme files themselves (`xcode-style.ts` says where): background, text, selection, the current line (the selected definition), keywords, strings, characters, numbers, regular expressions, comments, documentation and its keywords, `// MARK:`, `#if` / `#import` (the directive itself, not the code an `#if` holds), attributes, web addresses, type and other declarations, the project's and the libraries' types and functions. SF Mono 12 with the themes' weights (light Regular, keywords Semibold; dark Medium, keywords Bold), line spacing 1.1, documentation in Helvetica; SF Mono is never downloaded, so other computers show Menlo or their monospace font. Only the code changes: the rest of the page keeps its own fonts and colours.
- To tell them apart a token can now carry a detail besides its kind: the name being declared, a type called like a function (Swift `Store()`), documentation, `MARK`, characters, regular expressions, the preprocessor. diffmap's own colours look at the kind only and are unchanged (compared pixel by pixel in ten languages, Ruby's code inside a regular expression too), but for Objective-C's own words, now keywords (`self`, `YES`, `@implementation`, `void`), and Swift's `#selector`, whose `#` takes its word's colour.
- The analysis lists the names the repo defines a symbol under that the page shows (`names` in the result), for the project / library colours. They go by name: a library method the repo also defines (`viewDidLoad`) counts as the project's.
- Not done: variables, properties and constants by who declares them (diffmap does not know stored properties, so they stay plain text), macros, the TypeScript highlighter's declarations; the gutter, which the themes leave to the system; the insertion point (the code has none).

### 36. TypeScript: imports through tsconfig aliases — DONE
- TypeScript was read without the repo's tsconfig, so an import written with `baseUrl` (`import "src/services/order.service"`) or a `paths` alias (`import "@app/..."`, `"@nestjs/common"`) pointed nowhere: the type of a service injected through it was unknown, and its calls were lost. A changed service method then showed no usage in the processor that calls it.
- The call graph now reads every `tsconfig*.json` / `jsconfig.json` in the repo, follows `extends` between them (comments and trailing commas allowed), and resolves each file's imports with the nearest config above it, so the projects of a monorepo keep their own aliases (Nx: `tsconfig.base.json` at the root).
- nestjs/nest (2,219 files, 154 tsconfig files): TypeScript links 4,196 -> 8,688, none lost, same time.
- Not followed: `extends` from a package (`@tsconfig/node20`, which has no aliases of the repo), project references.

### 35. Objective-C, linked with Swift; the definition is the line with the name — DONE
- Objective-C (`.m`, `.mm`) is a language of its own (`languages/objc.ts`): classes, categories, methods, protocols, C functions; message sends, C calls and `@selector(..)`.
- It shares a family with Swift, and its methods are named the way Swift sees them (`saveItem(_:completion:)`, `init(name:)`), so calls link both ways: Swift to an Objective-C method (also with a trailing closure for a block), class method or class; Objective-C to Swift through `[[T alloc] initWith..]`, `[x method:..]` and `[T classMethod:..]`.
- Not followed: Swift's further renaming on import (`saveItem:` as `save(_:)`, `NS_SWIFT_NAME`), `@objc(otherName:)`, and headers, which are still read as C, so a class's parent and its properties' types are only known when the `.m` file writes them.
- The page: a definition is shown on the line that writes its name. Before, it was the first line of the definition, which for `@objc` (or `@IBAction`, `@Override`, a decorator) on a line of its own was the attribute. Swift names with labels are underlined by their name (`storeItem`), not by what follows the last colon.

### 34. Swift: quicker, and the library's own methods left alone — DONE
- Linking repeats less: the symbols of a name (in one language family) and those that accept a call's labels are worked out once, not once per call (`init` has 2,428 in kickstarter/ios-oss); the second look at a Swift file reuses the symbols found in the first. Whole-repo linking of ios-oss (2,084 Swift files): 28.7 s -> 19.8 s, link for link the same on five repos.
- A library type the repo only adds to (`extension Signal { ... }`) counted as a type of the repo, so `signal.observe(..)` and `signal.filter { }` were tied to the repo's only method of that name on another type (5 of 30 sampled links in ios-oss). When the method is not one the repo adds, it is the library's own. ios-oss: 90 links gone, Alamofire: 26, none new; the ones looked at were all of this kind.
- Still slow in Swift: every file is parsed twice (the second look needs the names from all files first).

### 33. Java: the type of a for-each variable; Java and Swift checked by hand — DONE
- `for (OrderItem item : items)` now gives `item` its type (a form of Java's own, `loopVariable`). macrozheng/mall: calls with one target 10,656 -> 10,711, with several 542 -> 501, with too many 71 -> 55.
- Neither language has a compiler index here, so random samples were read against the source (before this fix):
  - Java, mall, hand-written code: of 40 linked calls 36 right, 3 with the right target among several, 1 wrong (a chained `.get(..)` on a library object tied to the repo's `RedisService.get`). Of 20 unlinked calls whose name exists in the repo, 16 rightly left out (library types, Lombok), 4 real ones missed (`getProductId` on 18 classes: too many to guess).
  - Swift, kickstarter/ios-oss: of 30 linked calls 25 right, 5 wrong (`signal.observe(..)` and `.filter { }` on ReactiveSwift types, tied to the repo's only method of that name). 10 of 10 linked property reads right. Of 20 unlinked calls, all 20 rightly left out.

### 32. Each language keeps to its own rules — DONE
- One file per language in `parsers/tree-sitter/languages/` (`kotlin.ts`, `swift.ts`, `java.ts`, ...), with everything that is that language's own: definitions, calls, what its grammar cannot read, how names are matched. Helpers several languages share are in `shared.ts`, which says so at the top.
- A variable's type is looked for only in the forms its language writes (`variableTypes`): `Svc svc` in Java, C#, C, C++ and PHP; `svc: Svc` in Kotlin, Swift, Python, Rust and Scala; Go's and Ruby's forms in Go and Ruby only. Before, every language's code was tried against every form.
- A call is linked only to code of its own family (`family`): Java, Kotlin and Scala together, C and C++ together, every other language alone. Before, a Java call could be tied to a Swift method of the same name, a Kotlin one to a function in a JavaScript bundle.
- `scripts/compare-links.ts <repo> --save before.json`, then `--against before.json` after a change: per language, the symbols and links that went and came. Moving the rules into files changed nothing on seven repos; the two rules above changed what they were meant to (libsignal: 266 Java, 155 Kotlin, 132 Swift and 697 Rust links to another language's code gone).
- libsignal against the compiler, Rust: precision 73.6% -> 73.1%, recall 73.9% -> 74.4%.

### 31. Kotlin the grammar could not read; infix calls — DONE
- The main languages are now TypeScript, Java and Kotlin, and Swift; this is the first Kotlin round.
- The bundled Kotlin grammar (2023) gives up on a file at: `fun interface`; an assignment to a property of what a call returns (`view.get().visible = true`); a modifier used as a name (`internal.launch()`, `{ open -> }`); `.where { }`; `1..<n`; `perform: Outer.Inner.() -> Unit`; `{ (_, key): Record -> }`; and any infix function whose name starts with `e` (`a eq b`). After such a line, methods fell out of their class. These are rewritten for the parser only, each character in place (`kotlinPrepare`), and the names are put back as written.
- Kotlin files with a parse error: Signal-Android 124 -> 34 of 5,214; JetBrains/Exposed 231 -> 54 of 985.
- Infix calls (`a eq b`, `x like y`) are calls now, linked only to functions declared `infix`. Exposed: 1,579 of them link to repo code.
- Links from Kotlin files: Exposed 45,165 -> 49,224; Signal-Android about the same in number (188,896 -> 189,388), with methods back in their classes.
- Still not read: `when` guards (`is A if x ->`), some `when` branches starting with `!`, and what a newer grammar would fix.

### 30. Rust and C++ calls written with their type; no guessing past a known type — DONE
- `DeviceId::new(1)`, `Self::new(..)`, `keys::address::DeviceId::new(..)` and C++ `Svc::make(1)` were read as one long name, so none of them was ever linked. They are now `new` called on `DeviceId`. `module::run()` and `ns::run()` are plain functions; `std::`, `core::` and `alloc::` are the standard library and left out.
- Rust: names the standard library gives nearly every type (`clone`, `into`, `iter`, `map`, `len`, ...) are not linked when the receiver's type is unknown.
- Rust, Java: when the receiver's type is known and that type (or a parent) does not write the method, something outside the code provides it (a derive, a library trait, Lombok's `@Getter`): another type's method of that name is no longer linked. Not for Kotlin, Swift or Go, where extensions and undeclared interfaces make that guess right too often to drop.
- Checked against the compiler on signalapp/libsignal (594 Rust files, `scripts/measure-accuracy.ts`): right links 6,336 -> 9,702, wrong 5,304 -> 3,474, missed 6,817 -> 3,423. Precision 54.4% -> 73.6%, recall 48.2% -> 73.9%.
- Java, macrozheng/mall: 96 calls lost their link; 14 of 14 looked at were calls on a Lombok class that had been tied to another class's getter or setter. C++, nlohmann/json: 2,404 more links, 5 fewer (not checked against a compiler). Go, Kotlin and Swift link as before (gin, Exposed, Alamofire).
- Still missing in Rust: calls inside macros (`assert_eq!(a.b(), ..)`), which the grammar does not parse.

### 29. Dashboard — DONE
- `/dashboard`, for the usernames in `ADMIN_USERS` (empty by default, so nobody): reviews being got ready now and how many wait for a slot; the last 50 analyses with their times, outcome and whether an index was used; totals since the start; memory; people signed in; each project's size on disk against the limit; the latest log lines. Refreshes every five seconds.
- Kept in memory only: the numbers start again with the service.

### 28. Lighter analysis: files read once, quicker matching — DONE
- What tree-sitter reads from a file (its symbols and calls) is kept by the file's text, in `diffmap-outlines.json` in the project's git folder. A later analysis of the same project parses only the files whose text changed. `--no-cache` on the command line reads everything again.
- Matching by name repeats less work: the patterns for a variable's type are built once per name and skipped when the code never mentions it; a type's field text and "can this file see that one" are remembered.
- Same links as before on seven repos (Alamofire, ios-oss, Exposed, nlohmann/json, libsignal, Signal-Android, gin), link for link. Whole-repo linking: Signal-Android 79 s -> 49 s, Exposed 11.4 s -> 8.3 s, ios-oss 26.9 s -> 21.7 s.
- A whole analysis of django (7,100 files): 24.4 s -> 19.0 s the first time, 11.4 s after that. mall: 3.6 s -> 3.0 s -> 2.0 s.
- Not done: parsing in several threads (would help the first analysis of a project), and the TypeScript side, which still type-checks the whole project each time.

### 27. Rust exact calls, and measuring accuracy — DONE
- A SCIP index from rust-analyzer (`rust-analyzer scip .`) gives exact calls for Rust, from the CLI (`--scip`) and from the CI job. Checked on signalapp/libsignal (594 Rust files, index made in under four minutes): 8,399 of 8,435 function definitions in the index line up with diffmap's symbols; the rest are functions a macro writes.
- rust-analyzer does not say which trait method an implementation stands for, so for such an index the "implements" links come from name matching: a changed implementation still shows who calls the trait method.
- On libsignal, after a change to `DeviceId::new`: name matching finds no caller, the index finds 101.
- `scripts/measure-accuracy.ts` scores name matching against an index (right, wrong, unconfirmed, missed per language). libsignal, Rust: 6,336 right, 5,304 wrong, 6,817 missed (precision 54%, recall 48%); many of the missed are `Type::new(...)` calls.
- Fix: with an index, a variable on a function's first lines was taken for the function itself.

### 26. Swift and iOS code — DONE
- Swift read badly for reasons of its own: methods are told apart by argument labels, properties hold code, files have no imports, and the bundled grammar was from 2023.
- Names carry labels (`tableView(_:cellForRowAt:)`, `init(frame:)`): before, every `tableView` and `init` of a file was one symbol and a change in the second was shown on the first one's lines. Calls must fit the labels. A changed signature is one modified method.
- Properties with code are symbols (computed, set up by a closure, with `didSet`, protocol requirements); reading one, `#selector(x)` and a function passed by name are uses.
- `super.x()`, a plain `x()` in a type, `Svc(a: 1)` -> `Svc.init(a:)`, `let t: Tab = .init(1)`; subscripts, `defer` and closures run on the spot are no longer calls; a chain over several lines reports each call on its own line (all languages).
- Files of one module see each other without imports; `@testable import`; UIKit's own class parents.
- Newer grammar (tree-sitter-swift 0.7.3 in `grammars/`, web-tree-sitter 0.25): macros, `package`, raw strings, typed throws, trailing commas. What it still cannot read (`if let x = try await f() {`, `#if` inside a type, `as? T ?? d`, `unsafe`, `catch A, B`, ... see `swiftPrepare`) is rewritten for the parser only. Signal-iOS, 2,704 Swift files: 1,760 had a parse error before, 27 now.
- Fewer links by name alone: `items.map { }` is no longer tied to the repo's one `map`. On Apple's sample-food-truck 100 caller -> target pairs went (checked one by one: wrong or renamed, two were right) and 200 came (subviews, inits, property reads). The "one target" count of `measure-links.ts` falls for that reason (Alamofire 66.8% -> 65.3%, ios-oss 73.0% -> 63.9%): it counted those as hits.
- Of two symbols with one name in a file (overloads that differ by parameter type, in any language), the changed one's lines are shown; before, always the first one's.
- Checked on Signal-iOS with a hand-made change of 13 files and 23 known answers (which symbol, which lines, who uses it): 23 right; analysis 110 s -> 55 s.
- Other languages, checked on ten repos (Java, Kotlin, Python, Go, JS, Ruby, PHP, Rust, C#, C++): the matching rules link every call as before; only the lines of chained calls changed. The newer web-tree-sitter recovers differently from code a grammar cannot read: one Kotlin file of 350 lost two methods of a class, and macro-heavy C++ headers (nlohmann/json, 49 of 666 files) come out differently, neither better nor worse.

### 25. File comments, right-to-left text, changed letters, collapse without losing your place — DONE
- "Comment" next to a file's name: a comment on the file as a whole (GitHub `subject_type: file`, GitLab `position_type: file`, with a general comment naming the file as the fallback). Shown under the file name and in the Comments tab.
- Arabic and Hebrew: runs inside code are isolated so they read correctly and don't move the code around them; in plain-text files a line that starts right-to-left is laid out right to left; comments and titles follow their text.
- Edited lines: the letters that changed are shaded stronger (word by word, then letter by letter inside a changed word; Arabic words stay whole). Lines with too little in common are left plain.
- Fix: ticking Viewed (or collapsing) from deep inside a long file no longer skips the files after it; the code stays on the collapsed file's header.

### 24. Review screen: quick on big changes, definition above / usages below — DONE
- Big merge requests: files and list entries off screen are not laid out (`content-visibility`); dividers are 12px to grab and apply once per frame. On a made-up 400-file change a resize step went from about 960 ms to one frame, selecting a symbol from about 190 ms to under 35 ms.
- The code column goes to the definition and stays there; the panel shows usages only, with the code around the one picked. "Show in the code above" takes the code to a usage.
- ← Back and Forward → (also the arrow keys), restoring what was selected.
- "Removed code" tab and a clickable count in the top bar: every call that still points at code the change removes.

### 16. "Viewed" resets when a file changes again — DONE
- A "viewed" tick is saved with a fingerprint of the file's change (its added and removed lines). A later push that changes the file again clears the tick and marks the file "Changed since you viewed it"; a rebase that leaves the change as it was keeps it. Ticks saved before this are cleared once.

### 23. Review screen: editor-like navigation, less clutter — DONE
- Sidebar is a folder tree (folders fold, single-child folders joined); file names coloured by added / modified / deleted; the map's cards follow the same order.
- No arrows: the selected symbol's definition and usages are highlighted. Click a usage to go to the definition; click a definition to step through its usages.
- Callers outside the change are placed next to the selected symbol, not at the top of the map.
- Right panel: one header line, one line of counts, usages grouped by file one line each (before/after snippets dropped; the map shows them).
- Fix: dragging the map no longer sticks when the button is released outside the window.

### 22. Smarter name matching (no compiler) — DONE
- Still one pass over the files, no build, no new dependencies. Measured with `scripts/measure-links.ts` (calls to repo code linked to exactly one target): Spring PetClinic 93.1% → 94.4%, macrozheng/mall 83.0% → 87.7% (too many candidates 6.4% → 0.7%), Alamofire 57.8% → 66.9%.
- Field and property types (`repo.save()`, `this.repo.save()`), also from Swift extensions and Go methods; calls on library types (`List`, `String`) are left out.
- Missing definitions: Swift structs, enums, `init`, protocol methods, computed properties, subscripts (extensions name what's inside them); Kotlin interfaces, enums, constructors, properties with a getter; C# properties with code; Java method references.
- Interface → implementation links (`implements`/`extends`, `: Base`, `impl Trait for`), through chains of parents; inherited methods; a changed implementation shows who calls the interface at depth 1.
- Return types and chains: `var o = repo.find(id); o.total()`, `repo.find(id).total()`, `-> Self`, globals like `let AF = Session.default`.
- Overloads by argument count; of same-named classes, the one the file imports.

### 21. GitHub pull requests — DONE
- One service per code host (`CODE_HOST`); run two copies for both. GitHub: pull requests incl. forks, review and conversation comments, line comments, replies, Approve (an APPROVE review), exact index from an Actions artifact, GitHub Enterprise. Full mode with a GitHub OAuth App, or view-only with personal tokens.

### 3. Arrow functions as class properties — DONE
- `handler = () => {...}` (and `= function () {}`) inside a class is a symbol in TypeScript and JavaScript; `this.handler()` links to it inside its class.

### 15. Better name matching — DONE
- Without an index, calls are narrowed to what the caller can reach: `self.x()`/`this.x()` → same class; `Svc.x()` or a variable with a written-down type → that class; else same file, then imported files or the same folder/package. Unreachable names are linked only when unique in the repo.

### 1. Wrong `added`/`removed` status — DONE
- Status comes from whether the symbol exists in the whole base and head file, not just on the changed lines. Covered by tests.

### 2. `.tsx` files parsed as `.ts` — DONE
- Files are parsed with their real extension.

### 6. Call graph — DONE
- For each changed symbol: who calls it and what it calls (`--depth N` hops), the exact lines of each call, and the whole source of callers. Calls into removed code are flagged `calls-removed`.

### 8. HTML review page — DONE
- Three-panel screen from the "Code change map" design: changed files and symbols with "viewed" progress; the map (foldable cards, whole file on demand, callers outside the diff with arrows); details (before/after, every place a symbol is used).
- Files over 500 lines (HTML over 300) start collapsed.
- Arrows: used by (solid), implemented by (dashed), call to removed code (red dashed).

### 10. Other languages — DONE
- JavaScript, Python, Java, Go, C#, PHP, Ruby, Rust, Kotlin, Swift, Scala, C and C++ through tree-sitter (symbols, calls matched by name, highlighting). TypeScript keeps the TypeScript compiler (exact). Other changed text files show as plain cards.

### 11. Exact calls from CI indexes — DONE
- SCIP indexes (scip-typescript, scip-java incl. Kotlin, scip-clang) from a `diffmap-index` CI job or `--scip`. Files the index covers get exact calls and "implements" links; the header says whether calls are exact.

### 12. GitLab service — DONE
- Docker image; sign in with GitLab (self-hosted or gitlab.com); open an MR by swapping the host or pasting the link.
- Comments synced with GitLab (line comments; quoted general comments for files outside the MR), replies, Approve / Revoke.
- Progress screen while the code downloads and is analysed; analysis in worker threads; results cached per MR version.
- "Viewed" saved per GitLab user and MR. Sign-ins in memory on purpose (a restart signs everyone out).

### 13. Angular templates — DONE
- Element and attribute selectors link templates to components and directives; `| pipe` to the pipe's `transform()`; `(click)="save()"` to the component's methods. A changed `*.component.html` counts as a change.

### 14. Ready for GitHub — DONE
- GitHub Actions (typecheck, tests, Docker build), `.env.example`, ignore rules, README.

---

## Before the first push to GitHub

- **License:** DONE (MIT).
- **Commit author:** kept as `wefc <wefc@localhost>` (decided).
- **Build error:** a `npm run build` error was reported but couldn't be reproduced; needs the error text.

## Needs a real test

- The service against a real GitLab (sign-in, comments, approve, progress screen on a big project).
- `ci/diffmap-index.gitlab-ci.yml` in a real pipeline.
- Real `scip-java` (Java, Kotlin) and `scip-clang` indexes; so far only scip-typescript and rust-analyzer were run for real.

---

## Next

### 17. Clearer waiting and capacity
- Show "waiting for N other merge requests" on the progress screen when all analysis slots are busy (today it already says "Analysing").
- Default `ANALYSIS_WORKERS` to the number of CPU cores instead of 2.
- Keep more than the last 20 analysed MR versions, or save them to disk so they survive a restart.

### 19. Finding your way in big changes
- Search for a file or function; a minimap of the canvas.

### 7. Impact analysis
- Follow callers of callers to get the full blast radius, ranked by distance.

### 9. Nx support
- Understand Nx monorepo project boundaries, so callers are labelled by project.

### 20. Swift exact calls
- No SCIP indexer exists for Swift yet. Possible later through Swift's own index store, or if an indexer appears.

### 5. Small polish
- `npm install` should build `dist/`, so `diffmap` works right away. (A `prepare` script would break the Docker build as it is; needs `npm ci --ignore-scripts` there.)
- A test that runs the real `diffmap` command end to end.

---

## Suggested order

Then the real tests above. Then 17, which make day-to-day reviews more accurate. 19, 7, 9 and 20 after that, in any order.
