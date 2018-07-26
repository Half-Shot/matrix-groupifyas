const Matrix = require("matrix-js-sdk");
const YAML = require("js-yaml");
const fs = require("fs");
const request = require("request");
const process = require("process");
const Datastore = require("nedb");
const Promise = require("bluebird");

const DELAY_FACTOR = 1500;

class GroupifyAS {
    constructor(configFile) {
        const cfg = require(configFile);
        this.adminClient = null;
        this.userDb = null;
        this.roomDb = null;
        this.asToken = null; // Appservice token

        this.suffix = cfg.suffix;
        this.baseUrl = cfg.baseUrl; // URL of the HS.
        this.token = cfg.adminToken; // Admin Users Token for setting groups
        this.regPath = cfg.regPath;
        this.userDataPath = cfg.users;
        this.roomDataPath = cfg.rooms;
        this.dry = false;
    }

    parseRegFile(path) {
        let doc;
        try {
            doc = YAML.safeLoad(fs.readFileSync(path, 'utf8'));
        } catch (e) {
            console.error(`Encountered an error when parsing ${path}`, e);
            throw Error("Registration file was not parsable");
        }

        const userRegex = doc.namespaces.users[0].regex;
        const group_id = doc.namespaces.users[0].group_id;
        if (group_id === undefined) {
            throw Error("AS has no group_id set for users, we can't do anything with it!");
        }
        return {
            group_id,
            userRegex,
            token: doc["as_token"]
        }
    }

    loadDatabase() {
        this.userDb = new Datastore({filename: this.userDataPath});
        this.userDb.loadDatabase();
        this.roomDb = new Datastore({filename: this.roomDataPath});
        this.roomDb.loadDatabase();
    }

    async getUsersFromAppservice(userRegex) {
        return new Promise((resolve, reject) => {
            this.userDb.find({id: new RegExp (userRegex) }, (err, docs) => {
                if (err != null) {
                    reject(err);
                } else {
                    resolve(docs);
                }
            });
        });
    }

    async getPortalsFromAppservice() {
        return new Promise((resolve, reject) => {
            this.roomDb.find({ }, (err, docs) => {
                if (err != null) {
                    reject(err);
                } else {
                    resolve(docs);
                }
            });
        }).then((rooms) => {
            return rooms.filter((room) => {
                return !(
                    room.id.startsWith("ADMIN") ||
                    room.id.startsWith("PM") || 
                    room.data.origin === "provision" // We do !provision as old rooms exist without an alias.
                );
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

    async run(args) {
        this.dry = args["dry-run"] === true;

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
        if (args["change-suffix"] || args["add-to-group"]) {
            try {
                ircMembers = await this.getUsersFromAppservice(regFile.userRegex);
                console.info(`Got ${ircMembers.length} appservice users from data file.`);
            } catch (e) {
                throw Error(`Failed to get users from irc database: ${e.message}`);
            }
        }

        if (args["change-suffix"]) {
            await this.changeDisplaynames(ircMembers);
        } else {
            console.log("Not changing user suffixes");
        }

        if (args["add-to-group"]) {
            await this.addToGroup(regFile, ircMembers);
        } else {
            console.log("Not adding users to groups");
        }

        if (args["modify-room-state"]) {
            await this.modifyRoomGroups(regFile);
        } else {
            console.log("Not modifying room state");
            return;
        }
    }

    async modifyRoomGroups(regFile) {
        console.log("Modifying room sufixes");
        const portalRooms = await this.getPortalsFromAppservice();
        console.log(`Found ${portalRooms.length} portal rooms`);
        await Promise.all(portalRooms.map((room, i) => {
            const progress = `(${i}/${portalRooms.length})`;
            return this.adminClient.getStateEvent(
                room.matrix_id,
                "m.room.related_groups"
            ).catch((err) => {
                if (err.errcode === "M_NOT_FOUND" ||
                    err.message === "Event not found.") { // Let's be really sure.
                    return Promise.resolve({groups: []});
                }
                console.error(`${progress} Couldn't get state event for ${room.matrix_id}: ${err}`);
            }).then((content) => {
                if (content.groups.includes(regFile.group_id)) {
                    console.log(`${progress} ${room.matrix_id} already has the group and will be left untouched.`);
                    return true;
                }
                content.groups.push(regFile.group_id);
                if (this.dry === true) {
                    return Promise.resolve();
                }
                return this.adminClient.sendStateEvent(
                    room.matrix_id,
                    "m.room.related_groups",
                    content
                );
            }).catch((err) => {
                console.error(`${progress} Couldn't set state event for ${room.matrix_id}: ${err}`);
                return true;
            }).then((ignored) => {
                if (ignored === true) {
                    return;
                } 
                console.log(`${progress} ${room.matrix_id} now has the group!`);
            })
        }));
    }

    async changeDisplaynames (ircMembers) {
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
    }

    async addToGroup(regFile, ircMembers) {
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
                this.userDb.update({id: userObject.id}, userObject, {}, (err, replaced) => {
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

module.exports = GroupifyAS;