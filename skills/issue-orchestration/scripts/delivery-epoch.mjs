export function createEpoch(id) {
  return {
    id,
    sealed: false,
    cutoverFrozen: false,
    disposition: null,
    stageReceipts: {},
  };
}

export function sealEpoch(epoch) {
  if (!epoch?.repositoryFingerprint) {
    throw new Error('canonical repositoryFingerprint is required before sealing an epoch');
  }
  return { ...epoch, sealed: true };
}

export function bindStageReceipt(epoch, stage, receipt) {
  const receipts = epoch.stageReceipts ?? {};
  if (Object.hasOwn(receipts, stage)) {
    throw new Error(`Stage receipt already bound; replay refused: ${stage}`);
  }

  const epochId = epoch.epochId ?? epoch.id;
  if (epochId !== undefined && receipt?.epochId !== epochId) {
    throw new Error('Stage receipt identity mismatch: epochId');
  }
  if (epoch.baseSha !== undefined && receipt?.baseSha !== epoch.baseSha) {
    throw new Error('Stage receipt identity mismatch: baseSha');
  }
  if (
    epoch.repositoryFingerprint !== undefined
    && receipt?.repositoryFingerprint !== undefined
    && receipt.repositoryFingerprint !== epoch.repositoryFingerprint
  ) {
    throw new Error('Stage receipt identity mismatch: repositoryFingerprint');
  }

  if (receipt?.receiptDigest !== undefined && Object.values(receipts).some((boundReceipt) =>
    boundReceipt?.receiptDigest === receipt.receiptDigest
  )) {
    throw new Error('Stage receipt replay refused: receiptDigest already bound');
  }

  return {
    ...epoch,
    stageReceipts: { ...receipts, [stage]: receipt },
  };
}

export function assertStageReceipt(epoch, stage) {
  const receipt = epoch.stageReceipts?.[stage];
  if (receipt === undefined) {
    throw new Error(`Missing stage receipt: ${stage}`);
  }
  return receipt;
}

export function freezeCutover(epoch) {
  return { ...epoch, cutoverFrozen: true };
}

export function setDisposition(epoch, disposition) {
  if (disposition === 'reusable-unchanged') {
    throw new Error('reusable-unchanged disposition is forbidden');
  }
  return { ...epoch, disposition };
}
