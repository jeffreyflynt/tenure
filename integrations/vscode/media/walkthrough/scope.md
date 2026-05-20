## Project scope isolation

Tenure keeps memory separate per project. Scope is resolved
automatically from your nearest `package.json`, `Cargo.toml`,
`go.mod`, or similar manifest.

To override, add a `.tenure` file at your project root:

```json
{ "projectId": "my-project" }
```

To set scope manually in any chat session: !scope domain:code/typescript
