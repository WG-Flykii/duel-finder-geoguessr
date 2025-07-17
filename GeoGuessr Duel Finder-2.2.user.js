// ==UserScript==
// @name         GeoGuessr Duel Finder
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Find all duels against a specific user
// @author       You
// @match        https://www.geoguessr.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    class GeoGuessrDuelFinder {
        constructor() {
            this.baseUrl = 'https://www.geoguessr.com/api';
            this.gameServerUrl = 'https://game-server.geoguessr.com/api';
            this.myUserId = null;
            this.duelsFound = [];
            this.processedGameIds = new Set();
        }

        async apiRequest(url, options = {}) {
            const requestOptions = {
                ...options,
                credentials: 'include',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            };

            const response = await fetch(url, requestOptions);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return await response.json();
        }

        async getMyProfile() {
            if (!this.myUserId) {
                const profile = await this.apiRequest(`${this.baseUrl}/v3/profiles`);
                this.myUserId = profile.id;
            }
            return this.myUserId;
        }

        async getActivities(count = 50, paginationToken = null) {
            let url = `${this.baseUrl}/v4/feed/private?count=${count}`;
            if (paginationToken) {
                url += `&paginationToken=${paginationToken}`;
            }

            const response = await this.apiRequest(url);

            let entries = [];
            if (Array.isArray(response)) {
                entries = response;
            } else if (response.entries && Array.isArray(response.entries)) {
                entries = response.entries;
            } else if (response.data && Array.isArray(response.data)) {
                entries = response.data;
            }

            return {
                entries: entries,
                paginationToken: response.paginationToken || null
            };
        }

        async getDuelDetails(gameId) {
            return await this.apiRequest(`${this.gameServerUrl}/duels/${gameId}`);
        }

        extractGameIds(activity) {
            const gameIds = [];

            if (!activity.payload) return gameIds;

            try {
                const payload = JSON.parse(activity.payload);

                if (Array.isArray(payload)) {
                    payload.forEach(event => {
                        if (event.payload && event.payload.gameId) {
                            const gameMode = event.payload.gameMode;
                            if (gameMode === 'Duels' || gameMode === 'TeamDuels') {
                                gameIds.push({
                                    gameId: event.payload.gameId,
                                    gameMode: gameMode,
                                    time: event.time || activity.time
                                });
                            }
                        }
                    });
                } else if (payload.gameId) {
                    const gameMode = payload.gameMode;
                    if (gameMode === 'Duels' || gameMode === 'TeamDuels') {
                        gameIds.push({
                            gameId: payload.gameId,
                            gameMode: gameMode,
                            time: payload.time || activity.time
                        });
                    }
                }
            } catch (error) {
                console.error('Error parsing payload:', error);
            }

            return gameIds;
        }

        async checkUserInDuel(gameId, targetUserId) {
            if (this.processedGameIds.has(gameId)) {
                return false;
            }

            this.processedGameIds.add(gameId);

            try {
                const duelData = await this.getDuelDetails(gameId);

                if (!duelData.teams || !Array.isArray(duelData.teams)) {
                    return false;
                }

                let userFound = false;

                for (const team of duelData.teams) {
                    if (team.players && Array.isArray(team.players)) {
                        for (const player of team.players) {
                            if (player.playerId === targetUserId) {
                                userFound = true;
                                break;
                            }
                        }
                    }
                    if (userFound) break;
                }

                if (userFound) {
                    return {
                        found: true,
                        duelData: duelData,
                        gameId: gameId,
                        gameLink: `https://www.geoguessr.com/duels/${gameId}/summary`
                    };
                }

                return false;

            } catch (error) {
                console.error(`Error checking duel ${gameId}:`, error);
                return false;
            }
        }

        async findDuelsAgainstUser(targetUserId, maxPages = 20, progressCallback = null) {
            await this.getMyProfile();

            this.duelsFound = [];
            this.processedGameIds.clear();
            let currentPage = 0;
            let consecutiveEmptyPages = 0;
            let totalActivities = 0;
            let totalDuelsChecked = 0;
            let paginationToken = null;

            while (currentPage < maxPages && consecutiveEmptyPages < 3) {
                if (progressCallback) {
                    progressCallback(`Processing page ${currentPage + 1}/${maxPages}...`);
                }

                try {
                    const result = await this.getActivities(50, paginationToken);
                    const activities = result.entries;
                    paginationToken = result.paginationToken;

                    totalActivities += activities.length;

                    if (!activities || activities.length === 0) {
                        consecutiveEmptyPages++;
                        if (consecutiveEmptyPages >= 3) break;
                        currentPage++;
                        continue;
                    }

                    if (!paginationToken) {
                        if (progressCallback) {
                            progressCallback(`Reached end of activities (no more pages)`);
                        }
                    }

                    consecutiveEmptyPages = 0;

                    const allGameIds = [];
                    for (const activity of activities) {
                        const gameIds = this.extractGameIds(activity);
                        allGameIds.push(...gameIds.map(g => ({...g, activity})));
                    }

                    const batchSize = 5;
                    for (let i = 0; i < allGameIds.length; i += batchSize) {
                        const batch = allGameIds.slice(i, i + batchSize);
                        const promises = batch.map(gameInfo =>
                            this.checkUserInDuel(gameInfo.gameId, targetUserId)
                        );

                        const results = await Promise.allSettled(promises);

                        for (let j = 0; j < results.length; j++) {
                            const result = results[j];
                            const gameInfo = batch[j];

                            if (result.status === 'fulfilled' && result.value && result.value.found) {
                                totalDuelsChecked++;

                                const duelData = {
                                    gameId: gameInfo.gameId,
                                    gameMode: gameInfo.gameMode,
                                    time: gameInfo.time,
                                    activity: gameInfo.activity,
                                    duelDetails: result.value.duelData,
                                    opponentId: targetUserId,
                                    gameLink: result.value.gameLink
                                };

                                this.duelsFound.push(duelData);

                                if (progressCallback) {
                                    progressCallback(`Found ${this.duelsFound.length} duel(s) so far...`);
                                }
                            }
                        }

                        await new Promise(resolve => setTimeout(resolve, 100));
                    }

                    currentPage++;

                    if (!paginationToken) {
                        break;
                    }

                    await new Promise(resolve => setTimeout(resolve, 200));

                } catch (error) {
                    console.error(`Error on page ${currentPage}:`, error);
                    break;
                }
            }

            return this.duelsFound;
        }

        formatResults(duels) {
            if (duels.length === 0) {
                return 'No duels found against this user.';
            }

            let result = `Found ${duels.length} duel(s):\n\n`;

            duels.forEach((duel, index) => {
                const date = new Date(duel.time).toLocaleString('en-US');
                const duelDetails = duel.duelDetails;
                const state = duelDetails.state || 'N/A';
                const rounds = duelDetails.rounds ? duelDetails.rounds.length : 'N/A';

                result += `${index + 1}. ${date}\n`;
                result += `   Mode: ${duel.gameMode}\n`;
                result += `   Rounds: ${rounds}\n`;
                result += `   https://www.geoguessr.com/duels/${duel.gameId}/summary\n\n`;
            });

            return result;
        }

        formatLinksOnly(duels) {
            if (duels.length === 0) {
                return 'No duels found against this user.';
            }

            return duels.map(duel => `https://www.geoguessr.com/duels/${duel.gameId}/summary`).join('\n');
        }

        async copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (err) {
                console.error('Clipboard error:', err);
                return false;
            }
        }

        downloadJSON(data, filename) {
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    }

    function createUI() {
        if (document.getElementById('duel-finder-ui')) return;

        const ui = document.createElement('div');
        ui.id = 'duel-finder-ui';
        ui.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            width: 400px;
            background: #2c3e50;
            color: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            z-index: 10000;
            font-family: Arial, sans-serif;
            font-size: 14px;
        `;

        ui.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <h3 style="margin: 0; color: #3498db;">Duel Finder</h3>
                <button id="close-duel-finder" style="background: #e74c3c; color: white; border: none; padding: 5px 10px; border-radius: 5px; cursor: pointer;">×</button>
            </div>

            <div style="margin-bottom: 15px;">
                <label style="display: block; margin-bottom: 5px;">User UUID:</label>
                <input type="text" id="target-user-id" placeholder="Enter UUID or profile URL" style="width: 100%; padding: 8px; border: none; border-radius: 5px; background: #34495e; color: white; box-sizing: border-box;">
            </div>

            <div style="margin-bottom: 15px;">
                <label style="display: block; margin-bottom: 5px;">Max pages to analyze:</label>
                <input type="number" id="max-pages" value="5" min="1" max="50" style="width: 100%; padding: 8px; border: none; border-radius: 5px; background: #34495e; color: white; box-sizing: border-box;">
            </div>

            <button id="search-duels" style="width: 100%; padding: 10px; background: #27ae60; color: white; border: none; border-radius: 5px; cursor: pointer; margin-bottom: 10px;">
                Search Duels
            </button>

            <div id="progress" style="display: none; margin-bottom: 10px; padding: 10px; background: #34495e; border-radius: 5px; font-size: 12px;"></div>

            <div id="results" style="max-height: 300px; overflow-y: auto; background: #34495e; padding: 10px; border-radius: 5px; font-size: 12px; white-space: pre-wrap; display: none;"></div>

            <div id="actions" style="display: none; margin-top: 10px;">
                <button id="copy-full" style="width: 48%; padding: 8px; background: #3498db; color: white; border: none; border-radius: 5px; cursor: pointer; margin-right: 4%; margin-bottom: 5px;">
                    Copy Full
                </button>
                <button id="copy-links" style="width: 48%; padding: 8px; background: #f39c12; color: white; border: none; border-radius: 5px; cursor: pointer; margin-bottom: 5px;">
                    Copy Links
                </button>
                <button id="download-json" style="width: 100%; padding: 8px; background: #9b59b6; color: white; border: none; border-radius: 5px; cursor: pointer;">
                    Download JSON
                </button>
            </div>
        `;

        document.body.appendChild(ui);

        const finder = new GeoGuessrDuelFinder();
        let currentResults = [];

        document.getElementById('close-duel-finder').onclick = () => {
            document.body.removeChild(ui);
        };

        document.getElementById('search-duels').onclick = async () => {
            const targetUserInput = document.getElementById('target-user-id').value.trim();
            const maxPages = parseInt(document.getElementById('max-pages').value);

            if (!targetUserInput) {
                alert('Please enter a user UUID or profile URL!');
                return;
            }

            let targetUserId = targetUserInput;
            if (targetUserInput.includes('/user/')) {
                targetUserId = targetUserInput.split('/user/')[1].split('?')[0].split('#')[0];
            }

            const progressDiv = document.getElementById('progress');
            const resultsDiv = document.getElementById('results');
            const actionsDiv = document.getElementById('actions');
            const searchBtn = document.getElementById('search-duels');

            progressDiv.style.display = 'block';
            resultsDiv.style.display = 'none';
            actionsDiv.style.display = 'none';
            searchBtn.disabled = true;
            searchBtn.textContent = 'Searching...';

            try {
                const duels = await finder.findDuelsAgainstUser(targetUserId, maxPages, (message) => {
                    progressDiv.textContent = message;
                });

                currentResults = duels;

                const formattedResults = finder.formatResults(duels);
                resultsDiv.textContent = formattedResults;
                resultsDiv.style.display = 'block';
                actionsDiv.style.display = 'block';

                progressDiv.textContent = `Complete! ${duels.length} duel(s) found`;

            } catch (error) {
                console.error('Search error:', error);
                progressDiv.textContent = `Error: ${error.message}`;
                resultsDiv.style.display = 'none';
                actionsDiv.style.display = 'none';
            }

            searchBtn.disabled = false;
            searchBtn.textContent = 'Search Duels';
        };

        document.getElementById('copy-full').onclick = async () => {
            const results = document.getElementById('results').textContent;
            const success = await finder.copyToClipboard(results);

            const btn = document.getElementById('copy-full');
            const originalText = btn.textContent;
            btn.textContent = success ? 'Copied!' : 'Error';
            setTimeout(() => btn.textContent = originalText, 2000);
        };

        document.getElementById('copy-links').onclick = async () => {
            const linksOnly = finder.formatLinksOnly(currentResults);
            const success = await finder.copyToClipboard(linksOnly);

            const btn = document.getElementById('copy-links');
            const originalText = btn.textContent;
            btn.textContent = success ? 'Copied!' : 'Error';
            setTimeout(() => btn.textContent = originalText, 2000);
        };

        document.getElementById('download-json').onclick = () => {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `duels_${timestamp}.json`;
            finder.downloadJSON(currentResults, filename);
        };

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.getElementById('duel-finder-ui')) {
                document.body.removeChild(ui);
            }
        });
    }

    function addTriggerButton() {
        const button = document.createElement('button');
        button.textContent = 'Duel Finder';
        button.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #3498db;
            color: white;
            border: none;
            padding: 10px 15px;
            border-radius: 25px;
            cursor: pointer;
            z-index: 9999;
            font-weight: bold;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        `;

        button.onclick = () => {
            createUI();
        };

        document.body.appendChild(button);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addTriggerButton);
    } else {
        addTriggerButton();
    }

})();