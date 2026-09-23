/**
 * Ambient module declaration for CSS Modules consumed by the client bundle.
 * tsdown's `dsh-css-modules-inline` plugin turns each `*.module.css` import into
 * the hashed local→global class map (default export) and injects the stylesheet
 * text as a `<style data-plugin>` tag at factory execution.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/client/css
 */

declare module '*.module.css' {
  /** Map of local class name to its hashed, bundle-unique class name. */
  const classes: Record<string, string>
  export default classes
}
