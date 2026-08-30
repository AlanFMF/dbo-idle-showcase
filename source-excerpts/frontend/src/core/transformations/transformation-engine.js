const WODBO_ADVANCED_PATHS = Object.freeze(['reborn','superReborn']);

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formMatchesId(form, formId) {
  const wanted = String(formId || '');
  if (!wanted) return false;
  return String(form?.id || '') === wanted ||
    (form?.legacyFormIds || []).some(id => String(id) === wanted);
}

function formMatchesVocation(form, vocationId) {
  const wanted = numeric(vocationId);
  if (!wanted) return false;
  return numeric(form?.vocationId) === wanted ||
    (form?.legacyVocationIds || []).some(id => numeric(id) === wanted);
}

export function transformationRoute(character, path = 'normal') {
  const forms = Array.isArray(character?.forms) ? character.forms : [];
  const ids = character?.wodboPaths?.[path]?.formIds;
  if (!Array.isArray(ids)) {
    return path === 'normal' ? forms : [];
  }
  const byId = new Map(forms.map(form => [String(form?.id || ''), form]));
  return ids.map(id => byId.get(String(id))).filter(Boolean);
}

export function availableRebornPaths(character) {
  if (!character?.wodboPaths) return [];
  return WODBO_ADVANCED_PATHS.filter(path =>
    transformationRoute(character,path).length > 0
  );
}

export function activeTransformationPath(state, character) {
  if (!character?.wodboPaths) return null;
  const available = availableRebornPaths(character);
  const explicit = String(state?.profile?.rebornPath || '');
  if (available.includes(explicit)) return explicit;

  const formId = String(state?.profile?.formId || '');
  if (formId) {
    const exact = (character.forms || []).find(form => String(form?.id || '') === formId);
    if (exact?.wodboPath) return exact.wodboPath;
    for (const path of ['normal',...available]) {
      if (transformationRoute(character,path).some(form => formMatchesId(form,formId))) {
        return path;
      }
    }
  }

  const vocationId = numeric(state?.profile?.vocationSourceId);
  if (vocationId) {
    if (transformationRoute(character,'normal').some(form => formMatchesVocation(form,vocationId))) {
      return 'normal';
    }
    // Legacy Reborn/Super Reborn source vocation ids are intentionally shared.
    // Saves made before V21.26 did not store a path; keep them on classic Reborn.
    for (const path of available) {
      if (transformationRoute(character,path).some(form => formMatchesVocation(form,vocationId))) {
        return available.includes('reborn') ? 'reborn' : path;
      }
    }
  }

  const rebornCompleted =
    numeric(state?.profile?.rebornCount) > 0 ||
    state?.rebornQuest?.completed === true;
  if (rebornCompleted && available.length) {
    return available.includes('reborn') ? 'reborn' : available[0];
  }
  return 'normal';
}

export function currentTransformationForm(state, character) {
  const forms = Array.isArray(character?.forms) ? character.forms : [];
  if (!forms.length) return null;

  const formId = String(state?.profile?.formId || '');
  if (formId) {
    const exact = forms.find(form => String(form?.id || '') === formId);
    if (exact) return exact;
  }

  if (character?.wodboPaths) {
    const path = activeTransformationPath(state,character) || 'normal';
    const route = transformationRoute(character,path);
    if (formId) {
      const alias = route.find(form => formMatchesId(form,formId));
      if (alias) return alias;
    }
    const vocationId = numeric(state?.profile?.vocationSourceId);
    if (vocationId) {
      const match = route.find(form => formMatchesVocation(form,vocationId));
      if (match) return match;
    }
    return route[0] || forms[0] || null;
  }

  return (
    (formId ? forms.find(form => formMatchesId(form,formId)) : null) ||
    forms.find(form => formMatchesVocation(form,state?.profile?.vocationSourceId)) ||
    forms[0] ||
    null
  );
}

export function rebornEntryForm(character, path) {
  if (!character) return null;
  const route = transformationRoute(character,path);
  return route[0] || null;
}

export function rebornChoicesFor(
  state,
  character,
  rebornVocationMap = {}
) {
  if (!state?.profile || !character) return [];

  if (character.wodboPaths) {
    const normal = transformationRoute(character,'normal');
    const current = currentTransformationForm(state,character);
    const finalNormal = normal.at(-1) || null;
    const atFinalNormal = Boolean(
      current && finalNormal && String(current.id) === String(finalNormal.id)
    );
    return availableRebornPaths(character).map(path => {
      const entryForm = rebornEntryForm(character,path);
      return {
        path,
        label:path === 'superReborn' ? 'Super Reborn' : 'Reborn',
        entryForm,
        available:atFinalNormal && Boolean(entryForm),
        permanent:true
      };
    });
  }

  const current = currentTransformationForm(state,character);
  const currentVocation = numeric(
    state.profile.vocationSourceId || current?.vocationId || character.vocationSourceId
  );
  const mapping = rebornVocationMap?.[String(currentVocation)];
  if (!mapping) return [];
  const entryForm = (character.forms || []).find(form =>
    numeric(form?.vocationId) === numeric(mapping.toVocation)
  ) || null;
  return [{
    path:'reborn',
    label:'Reborn',
    entryForm,
    mapping,
    available:Boolean(entryForm),
    permanent:true
  }];
}

export function nextTransformationFor(
  state,
  character,
  standardTransitions
) {
  if (!state?.profile || !character) return null;

  if (character.wodboPaths) {
    const path = activeTransformationPath(state,character) || 'normal';
    const route = transformationRoute(character,path);
    const currentForm = currentTransformationForm(state,character);
    const currentIndex = route.findIndex(form => String(form?.id) === String(currentForm?.id));
    if (currentIndex < 0 || currentIndex >= route.length - 1) return null;
    const form = route[currentIndex + 1];
    const requiredLevel = Math.max(1,numeric(form?.level) || 1);
    return {
      fromVocation:numeric(currentForm?.vocationId),
      toVocation:numeric(form?.vocationId),
      lookType:numeric(form?.lookType),
      currentVocation:numeric(currentForm?.vocationId),
      requiredLevel,
      form,
      path,
      wodbo:true,
      available:numeric(state.profile.level || 1) >= requiredLevel
    };
  }

  const currentForm = currentTransformationForm(state, character);
  const currentVocation = numeric(
    state.profile.vocationSourceId ||
    currentForm?.vocationId ||
    character.vocationSourceId
  );
  const transition = standardTransitions?.[String(currentVocation)];
  if (!transition) return null;

  const form = (character.forms || []).find(entry =>
    formMatchesVocation(entry,transition.toVocation)
  ) || null;
  const requiredLevel = Math.max(1,numeric(transition.requiredLevel || 1));

  return {
    ...transition,
    currentVocation,
    requiredLevel,
    form,
    available:numeric(state.profile.level || 1) >= requiredLevel
  };
}

export function applyNextTransformation(
  state,
  character,
  standardTransitions
) {
  const next = nextTransformationFor(state,character,standardTransitions);

  if (!next) {
    return {
      ok:false,
      reason:'no-transition',
      message:'Não existe uma próxima transformação padrão.'
    };
  }

  if (!next.available) {
    return {
      ok:false,
      reason:'level',
      requiredLevel:next.requiredLevel,
      message:`Você precisa estar no level ${next.requiredLevel} para transformar.`
    };
  }

  if (!next.form) {
    return {
      ok:false,
      reason:'missing-form',
      toVocation:next.toVocation,
      message:`A forma da vocação ${next.toVocation} não possui sprite válida.`
    };
  }

  state.profile.formId = next.form.id;
  state.profile.vocationSourceId = numeric(next.form.vocationId || next.toVocation);
  if (next.wodbo && next.path !== 'normal' && !state.profile.rebornPath) {
    state.profile.rebornPath = next.path;
  }

  return {
    ok:true,
    transition:next,
    form:next.form,
    message:
      `Transformação concluída: ${next.form.name || `vocação ${next.toVocation}`} ` +
      `(lookType ${next.form.lookType || next.lookType}).`
  };
}
