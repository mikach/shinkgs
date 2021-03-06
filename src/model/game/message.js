// @flow
import {
  parseGameChannel,
  parseGameSummary
} from './parse';
import {isGameProposalPlayer, computeGameNodeStates} from './tree';
import {
  sortGames
} from './display';
import type {
  AppState,
  KgsMessage,
  GameChannel,
  GameSummary,
  GameTree,
  Index,
  ChannelMembership
} from '../types';

function _handleGameMessage(
  prevState: AppState,
  msg: KgsMessage
): AppState {
  let chanId = msg.channelId;
  if (msg.type === 'ROOM_JOIN' || msg.type === 'GAME_LIST' || msg.type === 'GLOBAL_GAMES_JOIN') {
    let gamesById: Index<GameChannel> = {...prevState.gamesById};
    if (msg.games) {
      for (let game of msg.games) {
        gamesById[game.channelId] = parseGameChannel(gamesById[game.channelId], game);
      }
    }
    let nextState = {...prevState, gamesById};

    // Channel membership
    if (msg.type === 'GLOBAL_GAMES_JOIN' && chanId) {
      let chanMem: ChannelMembership = {...prevState.channelMembership};
      chanMem[chanId] = {type: 'gameList', complete: false, stale: false};
      nextState.channelMembership = chanMem;
    }

    return nextState;
  } else if (msg.type === 'GAME_CONTAINER_REMOVE_GAME' && chanId) {
    // Note - we don't actually track game/channel associations other than roomId,
    // which is attached to the game channel record itself. We only remove games
    // that should be removed from all views (global list, room, game screen)
    let game = prevState.gamesById[msg.gameId];
    if (game) {
      let watching = prevState.channelMembership[msg.gameId];
      let inRoom = prevState.channelMembership[game.roomId];
      if (!watching && (!inRoom || (inRoom && game.roomId === chanId))) {
        let gamesById: Index<GameChannel> = {...prevState.gamesById};
        gamesById[msg.gameId] = {
          ...game,
          deletedTime: Date.now()
        };
        let nextState = {...prevState, gamesById};
        if (nextState.playChallengeId === msg.gameId) {
          nextState.playChallengeId = null;
        }
        return nextState;
      }
    }
  } else if (
    (msg.type === 'GAME_JOIN' ||
      msg.type === 'GAME_UPDATE' ||
      msg.type === 'GAME_STATE' ||
      msg.type === 'GAME_NAME_CHANGE' ||
      msg.type === 'CHALLENGE_JOIN') &&
    chanId
  ) {

    // Special case to remove game name
    if (msg.type === 'GAME_NAME_CHANGE' && !msg.name) {
      msg.name = null;
    }

    let gamesById: Index<GameChannel> = {...prevState.gamesById};
    let game = parseGameChannel(gamesById[chanId], msg);
    let summary = game.summary;
    gamesById[chanId] = game;
    let nextState = {...prevState, gamesById};

    // Channel membership
    if (msg.type === 'GAME_JOIN' || msg.type === 'CHALLENGE_JOIN') {
      let chanMem: ChannelMembership = {...prevState.channelMembership};
      chanMem[chanId] = {type: 'game', complete: false, stale: false};
      nextState.channelMembership = chanMem;

      if (prevState.watchGameId && summary && summary.timestamp === prevState.watchGameId) {
        nextState.watchGameId = chanId;
      } else if (prevState.playGameId && summary && summary.timestamp === prevState.playGameId) {
        nextState.playGameId = chanId;
      }
    }

    return nextState;
  } else if (msg.type === 'GAME_NOTIFY') {
    let gamesById: Index<GameChannel> = {...prevState.gamesById};
    let gameId = msg.game.channelId;
    gamesById[gameId] = parseGameChannel(gamesById[gameId], msg.game);
    return {...prevState, gamesById};
  } else if (msg.type === 'AUTOMATCH_PREFS') {
    return {...prevState, automatchPrefs: msg};
  } else if (msg.type === 'ARCHIVE_JOIN' && chanId) {
    let gameSummariesByUser: Index<Array<GameSummary>> = {...prevState.gameSummariesByUser};
    let name = msg.user.name;
    let summaries = msg.games.map(g => parseGameSummary(g));
    summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    gameSummariesByUser[name] = summaries;
    let nextState = {...prevState, gameSummariesByUser};

    // Channel membership
    let chanMem: ChannelMembership = {...prevState.channelMembership};
    chanMem[chanId] = {type: 'archive', complete: false, stale: false};
    nextState.channelMembership = chanMem;

    return nextState;
  } else if (msg.type === 'ARCHIVE_GAMES_CHANGED') {
    // FIXME: hack - hardcoded to currentUser since the message doens't include
    // the user, and we only stay subscribed to archive for currentUser
    let gameSummariesByUser: Index<Array<GameSummary>> = {...prevState.gameSummariesByUser};
    let name = prevState.currentUser ? prevState.currentUser.name : 'FIXME';
    let summaries = msg.games.map(g => parseGameSummary(g));
    let oldSummaries = gameSummariesByUser[name];
    if (oldSummaries) {
      let mergedSummaries = [...oldSummaries];
      for (let summary of summaries) {
        let index = mergedSummaries.findIndex(s => s.timestamp === summary.timestamp);
        if (index >= 0) {
          mergedSummaries[index] = summary;
        } else {
          mergedSummaries.push(summary);
        }
      }
      mergedSummaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      gameSummariesByUser[name] = mergedSummaries;
    } else {
      summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      gameSummariesByUser[name] = summaries;
    }
    return {...prevState, gameSummariesByUser};
  } else if (msg.type === 'ARCHIVE_GAME_REMOVED') {
    // FIXME: hack - hardcoded to currentUser since the message doens't include
    // the user, and we only stay subscribed to archive for currentUser
    let gameSummariesByUser: Index<Array<GameSummary>> = {...prevState.gameSummariesByUser};
    let name = prevState.currentUser ? prevState.currentUser.name : 'FIXME';
    let oldSummaries = gameSummariesByUser[name];
    if (oldSummaries) {
      gameSummariesByUser[name] = oldSummaries.filter(summary =>
        summary.timestamp !== msg.timestamp
      );
      return {...prevState, gameSummariesByUser};
    }
  } else if (msg.type === 'WATCH_FILTER_CHANGE') {
    return {...prevState, watchFilter: prevState.watchFilter ? {...prevState.watchFilter, ...msg.filter} : msg.filter};
  } else if (msg.type === 'PLAY_FILTER_CHANGE') {
    return {...prevState, playFilter: prevState.playFilter ? {...prevState.playFilter, ...msg.filter} : msg.filter};
  } else if (msg.type === 'WATCH_GAME') {
    return {...prevState, watchGameId: msg.gameId, userDetailsRequest: null};
  } else if (msg.type === 'PLAY_CHALLENGE') {
    // TODO - do we need to reset challengeStatus and sentProposal?
    return {...prevState, playChallengeId: msg.challengeId};
  } else if (msg.type === 'CLOSE_CHALLENGE' && chanId) {
    let gamesById: Index<GameChannel> = {...prevState.gamesById};
    gamesById[chanId] = {...gamesById[chanId], challengeStatus: 'viewing'};
    return {
      ...prevState,
      gamesById,
      playChallengeId: null
    };
  } else if (msg.type === 'CHALLENGE_DECLINE' && chanId) {
    let gamesById: Index<GameChannel> = {...prevState.gamesById};
    gamesById[chanId] = {...gamesById[chanId], challengeStatus: 'declined'};
    return {
      ...prevState,
      gamesById
    };
  } else if (msg.type === 'START_CHALLENGE_SUBMIT' && chanId) {
    let gamesById: Index<GameChannel> = {...prevState.gamesById};
    gamesById[chanId] = {
      ...gamesById[chanId],
      challengeStatus: 'waiting',
      sentProposal: msg.proposal
    };
    return {
      ...prevState,
      gamesById
    };
  } else if (msg.type === 'CHALLENGE_FINAL') {
    let currentUser = prevState.currentUser;
    let name = currentUser && currentUser.name;
    let isPlayer = name && isGameProposalPlayer(name, msg.proposal);
    let nextState = {...prevState, playChallengeId: null};
    if (isPlayer) {
      nextState.playGameId = msg.gameChannelId;
    } else {
      nextState.watchGameId = msg.gameChannelId;
    }
    return nextState;
  } else if (msg.type === 'PLAY_GAME') {
    return {...prevState, playGameId: msg.gameId, userDetailsRequest: null};
  } else if (msg.type === 'GAME_UNDO_REQUEST' && chanId) {
    // Note - API returns a weird response for role
    let matches = msg.role.match(/\[([^\]]+)\]/);
    let role = (matches && matches[1]) || msg.role;
    let gamesById: Index<GameChannel> = {...prevState.gamesById};
    gamesById[chanId] = {...gamesById[chanId], undoRequest: role};
    return {...prevState, gamesById};
  } else if (msg.type === 'GAME_UNDO_DECLINE' && chanId) {
    let gamesById: Index<GameChannel> = {...prevState.gamesById};
    gamesById[chanId] = {...gamesById[chanId]};
    delete gamesById[chanId].undoRequest;
    return {...prevState, gamesById};
  } else if (msg.type === 'START_GAME_MOVE' && chanId) {
    let gamesById: Index<GameChannel> = {...prevState.gamesById};
    gamesById[chanId] = {...gamesById[chanId]};
    let tree = gamesById[chanId].tree;
    if (tree) {
      tree = ({...tree}: GameTree);
      tree.pendingMove = {
        nodeId: tree.activeNode,
        color: msg.color,
        loc: msg.loc
      };
      tree.computedState = computeGameNodeStates(tree, tree.activeNode);
      gamesById[chanId].tree = tree;
      return {...prevState, gamesById};
    }
  } else if (msg.type === 'USER_REMOVED' && chanId && prevState.gamesById[chanId]) {
    let gamesById: Index<GameChannel> = {...prevState.gamesById};
    let users = gamesById[chanId].users;
    if (!users) {
      return prevState;
    }
    gamesById[chanId] = {
      ...gamesById[chanId],
      users: users.filter(name => name !== msg.user.name)
    };
    return {...prevState, gamesById};
  } else if (msg.type === 'USER_ADDED' && chanId && prevState.gamesById[chanId]) {
    let gamesById: Index<GameChannel> = {...prevState.gamesById};
    let users = gamesById[chanId].users;
    if (!users || users.find(name => name === msg.user.name)) {
      return prevState;
    }
    gamesById[chanId] = {
      ...gamesById[chanId],
      users: [...users, msg.user.name]
    };
    return {...prevState, gamesById};
  } else if (msg.type === 'CHANNEL_SUBSCRIBERS_ONLY' && chanId) {
    let gamesById: Index<GameChannel> = {
      ...prevState.gamesById,
      [chanId]: {
        ...prevState.gamesById[chanId],
        accessDenied: 'KGS Plus Subscribers Only'
      }
    };
    return {...prevState, gamesById};
  } else if (msg.type === 'PRIVATE_KEEP_OUT' && chanId) {
    let game = prevState.gamesById[chanId];
    if (!game) {
      return prevState;
    }
    let gamesById: Index<GameChannel> = {
      ...prevState.gamesById,
      [chanId]: {
        ...prevState.gamesById[chanId],
        accessDenied: 'Private Game'
      }
    };
    return {...prevState, gamesById};
  }
  return prevState;
}


export function handleGameMessage(
  prevState: AppState,
  msg: KgsMessage
): AppState {

  let nextState = _handleGameMessage(prevState, msg);

  // If games changed, separate active games from challenges; sort
  if (prevState.gamesById !== nextState.gamesById) {
    let allGames = Object.keys(nextState.gamesById).map(id => nextState.gamesById[id]);

    let activeGames = allGames.filter(g => g.type !== 'challenge' && !g.deletedTime);
    sortGames(activeGames);
    nextState.activeGames = activeGames;

    let challenges = allGames.filter(g => g.type === 'challenge' && !g.deletedTime);
    sortGames(challenges);
    nextState.challenges = challenges;
  }

  let currentUser = nextState.currentUser;
  if (currentUser) {
    let nextSummaries = nextState.gameSummariesByUser[currentUser.name];
    let prevSummaries = prevState.gameSummariesByUser[currentUser.name];
    if (prevSummaries !== nextSummaries) {
      nextState.unfinishedGames = nextSummaries.filter(summary =>
        summary.score === 'UNFINISHED' && summary.inPlay
      );
    }
  }

  return nextState;
}
