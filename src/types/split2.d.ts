// Minimal ambient type declaration for `split2`. The package is shipped
// without its own `.d.ts`, and we only use one of its overloads (mapper
// function receiving each line and returning the parsed value). Declared
// locally so we don't take on a runtime dependency.
//
// This file is intentionally a SCRIPT (no top-level import/export) so
// TypeScript treats `declare module "split2"` as an ambient declaration
// visible to every source file in the project.
//
// Source: https://github.com/mcollina/split2

declare module "split2" {
  import type { Transform } from "node:stream";

  type Mapper = (line: string) => unknown;

  function split2(mapper: Mapper): Transform;
  function split2(matcher: string | RegExp, mapper?: Mapper): Transform;
  function split2(matcher: string | RegExp, options: object, mapper?: Mapper): Transform;
  function split2(options: object, mapper?: Mapper): Transform;

  export default split2;
}
