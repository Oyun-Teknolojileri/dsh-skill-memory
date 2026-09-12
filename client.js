// Skill Memory - browser half.
//
// Registers the card for this plugin's settings namespace. The Plugins settings
// section enumerates the namespaces the Host serves and dispatches
// `settings.plugin.item` once per namespace, keyed by that namespace, so this
// file and the Host's `settings.register('skill-memory', ...)` are two halves of
// one feature: without either one no card is rendered.
//
// `applies: 'live'` on the Host namespace means every toggle here takes effect
// without a restart.
window.__ModuleLoader__.load({
  id: 'dsh-skill-memory',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const NS = 'skill-memory';
    const inject = ['slots'];

    const { useState, useEffect, useCallback } = React;

    /** Unwrap one `RemoteResult` or throw the failure it carries. */
    function unwrap(result, label) {
      if (result === null || typeof result !== 'object') throw new Error(label + ' returned no result');
      if (result.ok === false) {
        const failure = result.error === null || result.error === undefined ? {} : result.error;
        throw new Error(label + ' failed: ' + String(failure.code === undefined ? 'unknown' : failure.code) + ': ' + String(failure.message === undefined ? '' : failure.message));
      }
      return result.value;
    }

    const styles = {
      section: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', borderRadius: '14px', background: 'var(--dsw-alias-bg-layer-3)', boxShadow: 'var(--dsw-elevation-stroke)' },
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      title: { margin: 0, fontSize: '14px', fontWeight: '600', color: 'var(--dsw-alias-label-primary)' },
      hint: { margin: 0, fontSize: '12.5px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      chip: { flex: 'none', fontSize: '11px', lineHeight: '16px', padding: '1px 6px', borderRadius: '5px' },
      rows: { display: 'flex', flexDirection: 'column', gap: '8px' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      rowText: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 },
      rowLabel: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      rowHint: { fontSize: '12px', lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' },
      error: { margin: 0, fontSize: '12.5px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
    };

    function chipStyle(active) {
      return Object.assign({}, styles.chip, active
        ? { background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)', color: 'var(--dsw-alias-state-success-primary)' }
        : { background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-tertiary)' });
    }

    function switchStyle(value, muted) {
      return {
        flex: 'none',
        minWidth: '58px',
        height: '26px',
        padding: '0 10px',
        borderRadius: '13px',
        border: 'none',
        font: 'inherit',
        fontSize: '12px',
        cursor: muted ? 'not-allowed' : 'pointer',
        opacity: muted ? '0.5' : '1',
        color: value ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
        background: value
          ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)'
          : 'var(--dsw-alias-bg-layer-1)',
      };
    }

    function ToggleRow(props) {
      const { label, hint, value, muted, busy, onToggle } = props;
      return h('div', { style: styles.row }, [
        h('div', { style: styles.rowText, key: 'text' }, [
          h('span', { style: styles.rowLabel, key: 'label' }, label),
          h('span', { style: styles.rowHint, key: 'hint' }, hint),
        ]),
        h('button', {
          key: 'button',
          type: 'button',
          role: 'switch',
          'aria-checked': value === true,
          'aria-label': label,
          disabled: muted === true || busy === true,
          onClick: onToggle,
          style: switchStyle(value === true, muted === true || busy === true),
        }, busy === true ? '...' : value === true ? 'On' : 'Off'),
      ]);
    }

    /**
     * The plugin's card. Reads its own namespace through the settings remote and
     * writes single-field patches back, so the Host's resolved value is the only
     * source of truth.
     */
    function SkillMemoryCard(props) {
      const ctx = props.ctx;
      const [view, setView] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');
      const [loaded, setLoaded] = useState(false);

      const reload = useCallback(async () => {
        try {
          const described = unwrap(await ctx.remote.settings.describe(), 'settings.describe');
          const namespaces = Array.isArray(described.namespaces) ? described.namespaces : [];
          const found = namespaces.find((entry) => entry.ns === NS) || null;
          setView(found);
          setError(found === null ? 'the Host does not serve the ' + NS + ' namespace yet' : '');
        } catch (failure) {
          setView(null);
          setError(failure !== null && failure !== undefined && failure.message ? failure.message : String(failure));
        } finally {
          setLoaded(true);
        }
      }, [ctx]);

      useEffect(() => { void reload(); }, [reload]);

      const write = useCallback(async (key, value) => {
        if (view === null) return;
        setBusy(key);
        try {
          unwrap(await ctx.remote.settings.update(NS, { [key]: value }, view.revision), 'settings.update');
          await reload();
        } catch (failure) {
          setError(failure !== null && failure !== undefined && failure.message ? failure.message : String(failure));
        } finally {
          setBusy('');
        }
      }, [ctx, view, reload]);

      const value = view !== null && view.value !== null && typeof view.value === 'object' ? view.value : {};
      const enabled = value.enabled !== false;
      const recall = value.recall !== false;
      const learn = value.learn !== false;

      const rows = loaded && view !== null ? [
        h(ToggleRow, {
          key: 'enabled',
          label: 'Enabled',
          hint: 'Master switch. Turning this off stops recall and learning; the skill_memory tool stays available.',
          value: enabled,
          muted: false,
          busy: busy === 'enabled',
          onToggle: () => { void write('enabled', !enabled); },
        }),
        h(ToggleRow, {
          key: 'recall',
          label: 'Recall',
          hint: 'Inject matching skills into each model step, and pinned skills into every step.',
          value: recall,
          muted: !enabled,
          busy: busy === 'recall',
          onToggle: () => { void write('recall', !recall); },
        }),
        h(ToggleRow, {
          key: 'learn',
          label: 'Learn',
          hint: 'Analyze each completed turn in the background and store or update skills.',
          value: learn,
          muted: !enabled,
          busy: busy === 'learn',
          onToggle: () => { void write('learn', !learn); },
        }),
      ] : [];

      return h('section', { style: styles.section }, [
        h('div', { style: styles.header, key: 'header' }, [
          h('div', { key: 'titles' }, [
            h('h4', { style: styles.title, key: 'title' }, 'Skill Memory'),
            h('p', { style: styles.hint, key: 'hint' }, 'Learns durable workspace knowledge from completed turns and recalls it into each model step. Changes apply immediately.'),
          ]),
          h('span', { key: 'chip', style: chipStyle(enabled) }, !loaded ? 'Loading' : enabled ? 'Enabled' : 'Disabled'),
        ]),
        h('div', { style: styles.rows, key: 'rows' }, rows),
        error.length > 0 ? h('p', { style: styles.error, key: 'error' }, error) : null,
      ]);
    }

    /** Required service: the UI slot registry. */
    function apply(ctx) {
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
        { name: 'settings.plugin.item', key: NS },
        (props) => h(SkillMemoryCard, Object.assign({}, props, { ctx })),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
