import * as path from "path";
import * as fs from "fs";
import { DemoModel, DemoParser } from "sdfz-demo-parser";

import { Database } from "./database";
import { FileProcessor as FileProcessor, FileProcessorConfig } from "./file-processor";
import { AllyTeamInstance } from "./model/ally-team";

export class DemoProcessor extends FileProcessor {
    protected db: Database;

    constructor(config: FileProcessorConfig) {
        super(config);

        this.db = config.db;
    }

    protected async processFile(filePath: string) {
        const fileBytes = (await fs.promises.stat(filePath)).size;
        const fileMB = fileBytes / 1048576;
        if (fileMB > 20) {
            throw new Error("File over 20MB, marking as error for now");
        }

        const demoParser = new DemoParser();

        const demoData = await demoParser.parseDemo(filePath);
        const mapScriptName = demoData.info.hostSettings.mapname;

        const [ map ] = await this.db.schema.map.findOrCreate({
            where: { scriptName: mapScriptName },
            defaults: {
                scriptName: mapScriptName
            }
        });

        const demoExisted = await this.db.schema.demo.destroy({
            where: { id: demoData.header.gameId }
        });

        if (demoExisted && this.config.verbose) {
            console.log("Demo already processed. Deleting and reprocessing...");
        }

        const numOfPlayers = demoData.info.players.length + demoData.info.ais.length;
        let preset: "ffa" | "team" | "duel" = "duel";
        if (demoData.info.allyTeams.length > 2) {
            preset = "ffa";
        } else if (numOfPlayers > 2) {
            preset = "team";
        } else if (numOfPlayers === 2) {
            preset = "duel";
        }

        const demo = await map.createDemo({
            id: demoData.info.meta.gameId,
            fileName: path.basename(filePath),
            engineVersion: demoData.info.meta.engine,
            gameVersion: demoData.info.hostSettings.gametype,
            startTime: demoData.info.meta.startTime,
            durationMs: demoData.info.meta.durationMs,
            fullDurationMs: demoData.info.meta.fullDurationMs,
            hostSettings: demoData.info.hostSettings,
            gameSettings: demoData.info.gameSettings,
            mapSettings: demoData.info.mapSettings,
            gameEndedNormally: demoData.info.meta.winningAllyTeamIds.length > 0,
            chatlog: demoData.chatlog,
            preset: preset,
            hasBots: demoData.info.ais.length > 0,
        });

        const allyTeams: { [allyTeamId: number]: AllyTeamInstance } = {};

        for (const allyTeamData of demoData.info.allyTeams) {
            const allyTeam = await demo.createAllyTeam({
                allyTeamId: allyTeamData.allyTeamId,
                startBox: allyTeamData.startBox!,
                winningTeam: allyTeamData.allyTeamId === demoData.info.meta.winningAllyTeamIds[0]
            });
            allyTeams[allyTeam.allyTeamId] = allyTeam;
        }

        const playerAndSpecs: Array<DemoModel.Info.Player | DemoModel.Info.Spectator> = [...demoData.info.players, ...demoData.info.spectators];
        for (const playerOrSpecData of playerAndSpecs) {
            const [ user ] = await this.db.schema.user.findOrCreate({
                where: { id: playerOrSpecData.userId },
                defaults: {
                    id: playerOrSpecData.userId!,
                    username: playerOrSpecData.name,
                    countryCode: playerOrSpecData.countryCode!,
                    rank: playerOrSpecData.rank,
                    skill: playerOrSpecData.skill,
                    skillUncertainty: playerOrSpecData.skillUncertainty
                }
            });

            user.username = playerOrSpecData.name;
            user.countryCode = playerOrSpecData.countryCode!;
            user.rank = playerOrSpecData.rank,
            user.skill = playerOrSpecData.skill,
            user.skillUncertainty = playerOrSpecData.skillUncertainty;

            await user.save();

            const [ alias ] = await user.getAliases({
                where: { alias: playerOrSpecData.name }
            });

            if (!alias) {
                await user.createAlias({
                    alias: playerOrSpecData.name
                });
            }

            if ("teamId" in playerOrSpecData) {
                const allyTeam = allyTeams[playerOrSpecData.allyTeamId];
                const player = await allyTeam.createPlayer({
                    playerId: playerOrSpecData.playerId,
                    name: playerOrSpecData.name,
                    teamId: playerOrSpecData.teamId,
                    handicap: playerOrSpecData.handicap,
                    faction: playerOrSpecData.faction,
                    countryCode: playerOrSpecData.countryCode!,
                    rgbColor: playerOrSpecData.rgbColor,
                    rank: playerOrSpecData.rank,
                    skillUncertainty: playerOrSpecData.skillUncertainty,
                    skill: playerOrSpecData.skill!,
                    startPos: playerOrSpecData.startPos
                });
                await user.addPlayer(player);
            } else {
                const spectator = await demo.createSpectator({
                    playerId: playerOrSpecData.playerId,
                    name: playerOrSpecData.name,
                    countryCode: playerOrSpecData.countryCode!,
                    rank: playerOrSpecData.rank,
                    skillUncertainty: playerOrSpecData.skillUncertainty,
                    skill: playerOrSpecData.skill!
                });
                await user.addSpectator(spectator);
            }
        }

        for (const aiData of demoData.info.ais) {
            const allyTeam = allyTeams[aiData.allyTeamId];
            const ai = await allyTeam.createAI({
                aiId: aiData.aiId,
                name: aiData.name,
                shortName: aiData.shortName,
                host: aiData.host,
                startPos: aiData.startPos,
                faction: aiData.faction,
                rgbColor: aiData.rgbColor,
                handicap: aiData.handicap
            });
        }

        return;
    }
}