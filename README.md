# skills

Agent skills I use and share. A skill is a folder with a `SKILL.md` and the files it references, so any agent that supports skills (for example [Kiro](https://kiro.dev)) can load it on demand.

## Skills

| Skill | What it does |
|---|---|
| [`dynamodb-to-dsql`](./dynamodb-to-dsql) | Migrates a TypeScript application from Amazon DynamoDB to Aurora DSQL with Drizzle ORM. Discovers the DynamoDB access patterns, proposes a relational replacement for each, and helps write an idempotent data-migration script and a cutover plan. |

The story behind `dynamodb-to-dsql` is in the article [From DynamoDB to Aurora DSQL](https://barlog.sk/blog/from-dynamodb-to-aurora-dsql).

## Install

Copy the skill folder into your project or your home directory:

```bash
# for one project
cp -r dynamodb-to-dsql <your-project>/.kiro/skills/

# for all projects
cp -r dynamodb-to-dsql ~/.kiro/skills/
```

The folder name has to match the `name` in the skill's front matter.

## Safety

The skills here are written to ask before they touch anything. `dynamodb-to-dsql` never writes to your AWS account, DynamoDB table or DSQL cluster without explicit confirmation, and it keeps item contents (emails, names, free text) out of its reports. Read a skill before you run it against production data.

## License

MIT
