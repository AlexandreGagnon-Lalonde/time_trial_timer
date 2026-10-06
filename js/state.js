// Shared session state, mutated by main.js and read by the other modules.
export const state = {
  room: null,         // room code we're operating in, or null in the lobby
  roomName: '',
  stamps: [],         // current room's stamps, sorted by epoch_ms ascending
  editingKey: null,   // stamp key open in the edit sheet
  splitsEnabled: false, // room-level flag: does the SPLIT button render?
  resultsHidden: false, // room-level flag: is the room locked to outsiders in the lobby?
  roster: [],         // current room's imported athlete names (display form), sorted
  spectateCode: null, // room code being watched read-only, or null
  team: null,         // team code whose screen we're on (or came from), or null
  teamName: '',       // that team's display name
  roomTeam: null,     // team the current room belongs to (meta.team), or null for an open room
};
