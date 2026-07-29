/**
 * @file The component vocabulary.
 *
 * Every screen is built from these and adds no styling of its own beyond
 * layout. That is what keeps the Sleeve Program actually applied rather than
 * approximately applied: a screen cannot round a corner or drop a shadow,
 * because nothing here offers it the option.
 *
 * Components take an `on` prop naming the ink field they sit on, and derive
 * their own foreground, secondary and rule colours from it via
 * {@link import('./tokens.js').onInk}. Nobody passes a colour by hand.
 */

import { useMemo } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text as RNText,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { dimOn, ink, motion, onInk, rule, ruleOn, space, type } from './tokens.js';
import { initials as toInitials } from '../lib/format.js';

/* -------------------------------------------------------------------- type */

/**
 * Text in one of the system's six roles.
 *
 * @param {object} props
 * @param {'sleeveTitle'|'display'|'headline'|'body'|'label'|'data'|'dataBold'} [props.role]
 * @param {string} [props.on] The ink field this text sits on. Default `'ink'`.
 * @param {boolean} [props.dim] Secondary text, tinted from its own surface.
 * @param {string} [props.color] Override. Reach for this only when the text is
 *   itself carrying meaning — a live figure in cyan, a target hit in vermilion.
 */
export function T({ role = 'body', on = 'ink', dim = false, color, style, children, ...rest }) {
  const base = type[role] ?? type.body;
  const resolved = color ?? (dim ? dimOn(on) : onInk(on));
  return (
    <RNText
      {...rest}
      style={[
        base,
        { color: resolved },
        // Label type is uppercase by definition, not by the caller remembering.
        role === 'label' && { textTransform: 'uppercase' },
        style,
      ]}
    >
      {children}
    </RNText>
  );
}

/* ------------------------------------------------------------------- rules */

/**
 * A horizontal rule. Hairline by default, structural when `structural`.
 *
 * This is how separation happens in Wax. There is no card, no elevation, no
 * border radius — two regions are divided by a line or by a change of ink.
 *
 * @param {object} props
 * @param {string} [props.on]
 * @param {boolean} [props.structural] 3px instead of 1.5px.
 * @param {string} [props.color]
 */
export function Rule({ on = 'ink', structural = false, color, style }) {
  return (
    <View
      style={[
        {
          height: structural ? rule.structural : rule.hair,
          backgroundColor: color ?? (structural ? onInk(on) : ruleOn(on)),
        },
        style,
      ]}
    />
  );
}

/* ------------------------------------------------------------------ fields */

/**
 * A full-bleed ink field. The system's only container.
 *
 * **The One Ink Rule**: a field carries exactly one ink plus black and stock.
 * Nesting two saturated inks is a design error, so pass `on` down rather than
 * wrapping a `Field` in a `Field`.
 *
 * @param {object} props
 * @param {'ink'|'board'|'vermilion'|'cyan'|'chartreuse'|'ultramarine'} [props.on]
 */
export function Field({ on = 'ink', style, children, ...rest }) {
  const background = on === 'board' ? ink.stock : ink[on] ?? ink.ink;
  return (
    <View {...rest} style={[{ backgroundColor: background }, style]}>
      {children}
    </View>
  );
}

/* ----------------------------------------------------------------- buttons */

/**
 * A button.
 *
 * Square, uppercase label type, and it **inverts** on press rather than
 * dimming: vermilion ground with ink text becomes ink ground with vermilion
 * text, in 140ms. That inversion is the system's entire interaction feedback
 * vocabulary.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {() => void} props.onPress
 * @param {'primary'|'ghost'|'quiet'} [props.variant]
 * @param {string} [props.on] The field this button sits on. Matters for `ghost`.
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.busy] Shows a spinner and blocks presses.
 * @param {boolean} [props.block] Fill the available width.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  on = 'ink',
  disabled = false,
  busy = false,
  block = false,
  style,
}) {
  const pressed = useSharedValue(0);
  const inert = disabled || busy;

  // Resting and inverted colours per variant. `quiet` is the only one that
  // does not invert — it is a text button in a dense row, where a full field
  // inversion would be louder than the action deserves.
  const palette = useMemo(() => {
    const fg = onInk(on);
    switch (variant) {
      case 'ghost':
        return { bg: 'transparent', fg, bgOn: fg, fgOn: on === 'ink' ? ink.ink : ink.stock, border: fg };
      case 'quiet':
        return { bg: 'transparent', fg: dimOn(on), bgOn: 'transparent', fgOn: fg, border: null };
      default:
        return { bg: ink.vermilion, fg: ink.ink, bgOn: ink.ink, fgOn: ink.vermilion, border: null };
    }
  }, [variant, on]);

  const animatedField = useAnimatedStyle(() => ({
    backgroundColor: pressed.value ? palette.bgOn : palette.bg,
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inert, busy }}
      disabled={inert}
      onPressIn={() => {
        pressed.value = withTiming(1, { duration: motion.state });
      }}
      onPressOut={() => {
        pressed.value = withTiming(0, { duration: motion.state });
      }}
      onPress={onPress}
      style={[block && { alignSelf: 'stretch' }, style]}
    >
      {({ pressed: isPressed }) => (
        <Animated.View
          style={[
            styles.button,
            variant === 'quiet' && styles.buttonQuiet,
            palette.border && { borderWidth: rule.structural, borderColor: palette.border },
            animatedField,
            inert && { opacity: 0.4 },
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={isPressed ? palette.fgOn : palette.fg} />
          ) : (
            <T role="label" color={isPressed ? palette.fgOn : palette.fg} style={styles.buttonLabel}>
              {label}
            </T>
          )}
        </Animated.View>
      )}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ chrome */

/**
 * A catalog mark — the WAX 4000-series number that every object in the system
 * carries. Set in Data type at a 60% tint of the field's own foreground.
 *
 * It is an identifier, not decoration: it is quotable and it appears again in
 * the alert that mentions the release.
 *
 * @param {object} props
 * @param {string} props.cat
 * @param {string} [props.on]
 */
export const Cat = ({ cat, on = 'ink' }) => (
  <T role="data" on={on} dim>
    {cat}
  </T>
);

/**
 * A section opener: catalog number, then the section's name, over a structural
 * rule. Sections in Wax are catalog entries, not feature blocks.
 *
 * @param {object} props
 * @param {string} props.cat
 * @param {string} props.name
 * @param {string} [props.on]
 */
export const Opener = ({ cat, name, on = 'ink' }) => (
  <View style={styles.opener}>
    <View style={styles.openerRow}>
      <T role="data" on={on} dim>
        {cat}
      </T>
      <T role="label" on={on}>
        {name}
      </T>
    </View>
    <Rule on={on} structural />
  </View>
);

/**
 * A state chip. Square, hard-edged, one ink.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {'vermilion'|'cyan'|'chartreuse'|'ultramarine'|'board'} [props.tone]
 */
export const Chip = ({ label, tone = 'chartreuse' }) => (
  <View style={[styles.chip, { backgroundColor: tone === 'board' ? ink.stock : ink[tone] }]}>
    <T role="label" color={onInk(tone)}>
      {label}
    </T>
  </View>
);

/**
 * The live dot: a vermilion square that breathes.
 *
 * A square, not a circle — the Square Corner Rule has no exceptions, and a
 * pulsing dot is exactly the kind of element that tempts one.
 *
 * @param {object} props
 * @param {string} [props.color]
 * @param {number} [props.size]
 */
export function LiveDot({ color = ink.vermilion, size = 8 }) {
  const pulse = useSharedValue(1);
  // Driven by a repeating timing rather than a loop with a callback, so it
  // costs nothing on the JS thread while a list scrolls over it.
  const animated = useAnimatedStyle(() => ({ opacity: pulse.value }));

  useMemo(() => {
    pulse.value = withTiming(0.25, { duration: 900 }, () => {
      pulse.value = withTiming(1, { duration: 900 });
    });
  }, [pulse]);

  return (
    <Animated.View
      style={[{ width: size, height: size, backgroundColor: color }, animated]}
    />
  );
}

/**
 * A square avatar. Falls back to initials on an ink field when there is no
 * image, which is most of the time in a demo.
 *
 * @param {object} props
 * @param {?string} props.url
 * @param {string} props.name
 * @param {number} [props.size]
 * @param {string} [props.tone] The ink the initials fallback prints in.
 */
export const Avatar = ({ url, name, size = 44, tone = 'vermilion' }) =>
  url ? (
    <Image source={{ uri: url }} style={{ width: size, height: size }} />
  ) : (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, backgroundColor: ink[tone] ?? ink.vermilion },
      ]}
    >
      <T role="label" color={onInk(tone)} style={{ fontSize: size * 0.3, letterSpacing: 0.5 }}>
        {toInitials(name)}
      </T>
    </View>
  );

/**
 * An empty state. Says what is missing and what to do about it — never just
 * "nothing here".
 *
 * @param {object} props
 * @param {string} props.title
 * @param {string} props.body
 * @param {string} [props.on]
 */
export const Empty = ({ title, body, on = 'ink' }) => (
  <View style={styles.empty}>
    <T role="headline" on={on}>
      {title}
    </T>
    <T role="body" on={on} dim style={{ marginTop: space.sm, maxWidth: 420 }}>
      {body}
    </T>
  </View>
);

/**
 * The synthetic-data disclaimer.
 *
 * Wax shows invented listing prices and pressing quantities. A collector about
 * to make a $200 decision must never mistake one for a real listing, so every
 * surface carrying synthetic figures says so. This is a product-integrity
 * requirement, not a stylistic flourish — do not remove it to tidy a layout.
 *
 * @param {object} props
 * @param {string} [props.on]
 * @param {string} [props.note]
 */
export const Synthetic = ({ on = 'ink', note = 'Sample data · synthetic listings' }) => (
  <T role="data" on={on} dim style={styles.synthetic}>
    {note}
  </T>
);

const styles = StyleSheet.create({
  button: {
    paddingVertical: 18,
    paddingHorizontal: 32,
    alignItems: 'center',
    justifyContent: 'center',
    // No borderRadius. The Square Corner Rule.
  },
  buttonQuiet: { paddingVertical: 10, paddingHorizontal: 0 },
  buttonLabel: { textAlign: 'center' },
  opener: { gap: space.xs, marginBottom: space.md },
  openerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: space.sm,
  },
  chip: { paddingHorizontal: space.xs + 2, paddingVertical: 4 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  empty: { paddingVertical: space.xl, paddingHorizontal: space.md },
  synthetic: { opacity: 0.55, fontSize: 11 },
});
