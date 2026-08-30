export const DONATION_MIN_BRL = 10;
export const DONATION_STEP_BRL = 1;
export const PREMIUM_POINTS_PER_BRL = 10;

export const DONATION_BONUS_TIERS = Object.freeze([
  Object.freeze({ minBrl: 1000, percent: 25 }),
  Object.freeze({ minBrl: 400, percent: 15 }),
  Object.freeze({ minBrl: 200, percent: 10 }),
  Object.freeze({ minBrl: 100, percent: 5 })
]);

export function normalizeDonationAmount(value,{min=DONATION_MIN_BRL}={}){
  const numeric=Number(value);
  if(!Number.isFinite(numeric))return min;
  return Math.max(min,Math.round(numeric));
}

export function donationBonusPercent(amountBrl){
  const amount=normalizeDonationAmount(amountBrl);
  return DONATION_BONUS_TIERS.find(tier=>amount>=tier.minBrl)?.percent||0;
}

export function donationQuote(amountBrl){
  const amount=normalizeDonationAmount(amountBrl);
  const basePp=amount*PREMIUM_POINTS_PER_BRL;
  const bonusPercent=donationBonusPercent(amount);
  const bonusPp=Math.round(basePp*bonusPercent/100);
  return Object.freeze({
    amountBrl:amount,
    basePp,
    bonusPercent,
    bonusPp,
    totalPp:basePp+bonusPp
  });
}

// Compatibilidade com chamadas antigas. O novo checkout nao recebe PP diretamente.
export function normalizePremiumPointAmount(value){
  const pp=Math.max(DONATION_MIN_BRL*PREMIUM_POINTS_PER_BRL,Math.round(Number(value)||0));
  return Math.round(pp/PREMIUM_POINTS_PER_BRL)*PREMIUM_POINTS_PER_BRL;
}
