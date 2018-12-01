# matrix-groupifyas
Group any appservice users and remove their suffixes

Edit `config.sample.json` appropriately for your setup (the fields should be self-explanatory), and then run
```
node cli.js --config config.json -r
```
and then
```
node cli.js --config config.json -s`
```

**NOTE**: It is recommended that you run each command with the `--dry-run` option _first_.
