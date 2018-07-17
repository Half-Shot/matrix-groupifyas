const CommandLineArgs = require("command-line-args");
const Matrix = require("matrix-js-sdk");
const YAML = require("js-yaml");
const fs = require("fs");
const request = require("request");
const process = require("process");
const Datastore = require("nedb");
const Promise = require("bluebird");

const DELAY_FACTOR = 1500;

class GroupifyAS {
    constructor() {
        const cfg = require("./config.json");
        this.adminClient = null;
        this.db = null;
        this.asToken = null; // Appservice token

        this.suffix = cfg.suffix;
        this.baseUrl = cfg.baseUrl; // URL of the HS.
        this.token = cfg.adminToken; // Admin Users Token for setting groups
        this.regPath = cfg.regPath;
        this.dataPath = cfg.dataPath;
        this.dry = cfg.dryRun === true;
        this.addToGroup = !(cfg.addToGroup === false);
    }

    parseRegFile(path) {
        let doc;
        try {
            doc = YAML.safeLoad(fs.readFileSync(path, 'utf8'));
        } catch (e) {
            console.error(`Encountered an error when parsing ${path}`, e);
            throw Error("Registration file was not parsable");
        }
        const regex = doc.namespaces.users[0].regex;
        const group_id = doc.namespaces.users[0].group_id;
        if (group_id === undefined) {
            throw Error("AS has no group_id set for users, we can't do anything with it!");
        }
        return {
            group_id,
            regex,
            token: doc["as_token"]
        }
    }

    loadDatabase() {
        this.db = new Datastore({filename: this.dataPath});
        this.db.loadDatabase();
    }

    async getUsersFromAppservice(regex) {
        return new Promise((resolve, reject) => {
            this.db.find({id: new RegExp (regex) }, (err, docs) => {
                if (err != null) {
                    reject(err);
                } else {
                    resolve(docs);
                }
            });
        });
    }

    parseGroupId(groupId) {
        groupId = groupId.split(":")[0];
        if (groupId.startsWith("+")) {
            groupId = groupId.substr(1);
        }
        console.log(groupId)
        return groupId;
    }

    async run() {

        let groupMembers;
        let ircMembers;

        const regFile = this.parseRegFile(this.regPath);
        this.asToken = regFile.token;
        this.adminClient = new Matrix.MatrixClient({
            accessToken: this.token,
            baseUrl: this.baseUrl,
            request
        });
        this.bridgeClient = new Matrix.MatrixClient({
            accessToken: this.asToken,
            baseUrl: this.baseUrl,
            request
        });

        // Check the bot works
        const user = await this.bridgeClient._http.authedRequest(undefined, "GET", "/account/whoami");
        console.log(`AsBot is ${user.user_id}`);

        this.loadDatabase();
        try {
            ircMembers = await this.getUsersFromAppservice(regFile.regex);
            console.info(`Got ${ircMembers.length} appservice users from data file.`);
        } catch (e) {
            throw Error(`Failed to get users from irc database: ${e.message}`);
        }

        // Change displaynames
        try {
            console.info("Replacing suffixes");
            let i = 0;
            await Promise.all(ircMembers.map((user) => {
                const name = this.getNewDisplayName(user);
                if (name === user.data.displayName) {
                    console.log(`Skipping as ${user.id} doesn't need updating.`);
                    return Promise.resolve();
                }

                return Promise.delay(i*DELAY_FACTOR).then(() => {
                    return this.removeSuffixFromUser(user, name);
                });
                i++;
            }));
        } catch (e) {
            throw Error(`Failed to update displaynames for appservice members: ${e.message}`);
        }

        if (!this.addToGroup) {
            console.log("Not adding users to groups");
            return;
        }
        
        try {
            console.log(`Creating group ${regFile.group_id}`);
            /*await this.adminClient.createGroup({
                localpart: this.parseGroupId(regFile.group_id),
                profile: {
                    name: "HalfyNet",
                    avatar_url: "",
                    short_description: "Shorter",
                    long_description: "Longer and longer",
                }
            });*/
            console.log(`Getting list of users from ${regFile.group_id}`);
            groupMembers = await this.getMembersFromGroup(regFile.group_id);
            console.info(`Got ${groupMembers.size} group members for ${regFile.group_id}`);
        } catch (e) {
            throw Error(`Failed to get group: ${e.errcode} ${e.message}`);
        }

        // Add to group
        await Promise.all(ircMembers.filter((user) =>
            { return !groupMembers.has(user.id); }
        ).map((user, i) => {
            console.log(`Adding ${user.id} to ${regFile.group_id}`);
            if(this.dry) {
                return Promise.resolve();
            }
            // Delay a bit
            return Promise.delay(i*DELAY_FACTOR).then(() => {
                return this.adminClient.inviteUserToGroup(
                    regFile.group_id,
                    user.id
                );
            }).catch(() => {
                console.warn(`Failed to invite ${user.id} to group, trying to accept anyway.`);
                // Accept invite even on failure, just in case we had one.
                this.getASUserClient(user.id).acceptGroupInvite(regFile.group_id);
            }).then(() => {
                // Accept invite even on failure, just in case we had one.
                this.getASUserClient(user.id).acceptGroupInvite(regFile.group_id);
            }).then(() => {
                console.log(`Added ${user.id} to group (${i}/${(ircMembers.length-groupMembers.size)})`);
            }).catch((e) => {
                console.error(`Failed to add ${user.id} to group`, e);
            });
        }));
    }

    async getMembersFromGroup(groupId) {
        const groupMembers = new Set();
        // According to Synapse we actually don't use chunking at all and send as one blob
        const res = await this.adminClient.getGroupUsers(groupId);
        res.chunk.forEach((member) => {
            groupMembers.add(member.user_id);
        });
        return groupMembers;
    }

    getNewDisplayName(userObject) {
        return userObject.data.displayName
                .trimEnd().replace(this.suffix, "").trimEnd();
    }

    removeSuffixFromUser(userObject, displayname) {
        return this.dry ? Promise.resolve() : this.getASUserClient(userObject.id).setDisplayName(displayname).then(() => {
            console.log(`Changed ${userObject.id}'s displayname to ${displayname}`);
            userObject.data.displayName = displayname;
            return new Promise((resolve, reject) => {
                this.db.update({id: userObject.id}, userObject, {}, (err, replaced) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(replaced);
                    }
                });
            });
        }).catch((e) => {
            console.error(`Cannot set displayname of ${userObject.id}`, e);
        });
    }

    getASUserClient(userId) {
        return this.bridgeClient = new Matrix.MatrixClient({
            accessToken: this.asToken,
            baseUrl: this.baseUrl,
            request,
            userId,
            queryParams: { user_id: userId }
        });
    }
}

new GroupifyAS().run()

.catch((e) => {
    console.error("Script failed to complete successfully:", e);
    process.exit(1);
});
