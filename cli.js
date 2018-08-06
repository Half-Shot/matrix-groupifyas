
const CommandLineArgs = require("command-line-args");
const CommandLineUsage = require('command-line-usage');

const GroupifyAS = require("./app.js");

const args = CommandLineArgs([
    {
        name: "add-to-group",
        alias: "a",
        type: Boolean
    },
    {
        name: "change-suffix",
        alias: "s",
        type: Boolean
    },
    {
        name: "modify-room-state",
        alias: "r",
        type: Boolean
    },
    {
        name: "dry-run",
        alias: "d",
        type: Boolean
    },
    {
        name: "help",
        alias: "h",
        type: Boolean
    },
    {
        name: 'config',
        alias: 'c',
        default: 'config.json',
        type: String
    },
    {
        name: 'delay',
        alias: 't',
        type: Number
    },
]);

const hasArg = ["add-to-group", "change-suffix", "modify-room-state"].some((a) => args[a] !== undefined);

if (args["help"] || !hasArg) {
    const sections = [
        {
            header: 'Groupify AS',
            content: 'Useful tools to make an appservice migrate to using groups.'
        },
        {
            header: 'Options',
            optionList: [
                {
                    name: 'add-to-group',
                    alias: 'a',
                    description: 'Add users to a group.'
                },
                {
                    name: 'change-suffix',
                    alias: 's',
                    description: 'Change appservice users suffix.'
                },
                {
                    name: 'modify-room-state',
                    alias: 'r',
                    description: 'Add groups to portal rooms.'
                },
                {
                    name: 'dry-run',
                    alias: 'd',
                    description: "Don't send any requests, only print info."
                },
                {
                    name: 'config',
                    alias: 'c',
                    default: 'config.json',
                    description: "Config file to use."
                },
                {
                    name: 'delay',
                    alias: 't',
                    description: "How long to delay user/group requests."
                },
                {
                    name: 'help',
                    description: 'Print this usage guide.'
                }
            ]
        }
    ]
    console.log(CommandLineUsage(sections));
    return;
}

new GroupifyAS("./" + args["config"]).run(args).catch((e) => {
    console.error("Script failed to complete successfully:", e);
    process.exit(1);
});
