(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RULES = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STAKES = [25, 50, 100, 200, 300, 500];
  const TIERS = [
    { completed: 0, stakes: [25, 50] },
    { completed: 3, stakes: [100] },
    { completed: 5, stakes: [200] },
    { completed: 7, stakes: [300] },
    { completed: 10, stakes: [500] },
  ];
  const DAILY_BASELINE = 300;
  const INVITE_TARGET = 1000;

  function allowedStakes(completed) {
    const count = Math.max(0, Number(completed) || 0);
    const unlocked = [];
    for (const tier of TIERS) {
      if (count >= tier.completed) {
        for (const stake of tier.stakes) {
          if (!unlocked.includes(stake)) unlocked.push(stake);
        }
      }
    }
    return unlocked.sort((a, b) => a - b);
  }

  function canStake(stake, completed) {
    return allowedStakes(completed).includes(Number(stake));
  }

  function nextTier(completed) {
    const count = Math.max(0, Number(completed) || 0);
    for (const tier of TIERS) {
      if (tier.completed > count) {
        return {
          completed: tier.completed,
          remaining: tier.completed - count,
          stakes: tier.stakes.slice(),
        };
      }
    }
    return null;
  }

  function stakeFromInput(value) {
    const stake = Number(value);
    return STAKES.includes(stake) ? stake : null;
  }

  return {
    STAKES,
    TIERS,
    DAILY_BASELINE,
    INVITE_TARGET,
    allowedStakes,
    canStake,
    nextTier,
    stakeFromInput,
  };
});
