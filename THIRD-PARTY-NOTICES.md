# Third-party notices

Folder Encrypt is licensed under the [MIT License](LICENSE). It contains or builds on the
following third-party work.

## Included in the plugin (`main.js`)

### monkey-around 3.0.0

- Author: PJ Eby
- Source: https://github.com/pjeby/monkey-around
- License: ISC, as declared in the package's `package.json`. The package does not ship a separate
  license file, so the standard ISC license text is reproduced here.

```
Copyright (c) PJ Eby

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Meld Encrypt

- Author: Cleon Pinto (meld-cp)
- Source: https://github.com/meld-cp/obsidian-encrypt
- License: MIT

Folder Encrypt is a companion to Meld Encrypt. Its file format and cryptography (`src/crypto/`) follow Meld
Encrypt's format 2.0 so that both plugins can read the same note content. `tests/meld-reference/` contains
unchanged copies of Meld Encrypt's crypto helpers, used only to test that compatibility. They are not part
of the plugin build.

```
MIT License

Copyright (c) 2021 Cleon Pinto

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Build and test tools (not included in the plugin)

These packages are only used to build and test the plugin. They are installed with `npm install` and
are not distributed with the plugin or this repository.

| Package | License | Copyright |
|---|---|---|
| [esbuild](https://github.com/evanw/esbuild) | MIT | Evan Wallace |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | Microsoft Corporation |
| [obsidian](https://github.com/obsidianmd/obsidian-api) (API type definitions) | MIT | Dynalist Inc. |
| [tslib](https://github.com/microsoft/tslib) | 0BSD | Microsoft Corporation |
| [builtin-modules](https://github.com/sindresorhus/builtin-modules) | MIT | Sindre Sorhus |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Microsoft Corporation |

Exact versions are pinned in `package-lock.json`.

The plugin runs inside [Obsidian](https://obsidian.md) and uses its plugin API. Obsidian itself is not
included.
