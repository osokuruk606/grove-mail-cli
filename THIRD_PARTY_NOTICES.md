# Third-party materials

The AgentMail OpenAPI and CLI discovery snapshots in `docs/reference/` originate from the official AgentMail CLI v1.5.0, maintained by AgentMail. Source: https://github.com/agentmail-to/agentmail-cli at commit `43ec9bfa1fc4c2641e80815e5c99246089b9ea8f`. They are retained as compatibility reference data, with their original descriptions and attribution.

The upstream [Cargo.toml](https://github.com/agentmail-to/agentmail-cli/blob/43ec9bfa1fc4c2641e80815e5c99246089b9ea8f/Cargo.toml) declares `license = "MIT"` and identifies AgentMail as its author. That declaration applies to the retained reference materials; Grove Mail's Apache-2.0 declaration does not replace their upstream terms. The OpenAPI snapshot is unmodified. The discovery snapshot records the upstream CLI's generated command descriptions.

The upstream README separately attributes the Fern CLI framework under Apache-2.0. That Rust framework implementation is not included in this client.

Grove Mail's CLI implementation is maintained separately from the official client. This repository does not contain AgentMail's hosted email server or console implementation, or mailcow's server implementation. Runtime dependencies retain their respective licenses in their distributed packages.

## MIT license terms for the AgentMail reference materials

Attribution: AgentMail, as identified in the upstream package metadata above.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
