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
};
