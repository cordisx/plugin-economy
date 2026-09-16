export default {
  plugins: ['@projectwallace/stylelint-plugin'],
  rules: {
    'projectwallace/max-lines-of-code': 1000,
    'block-no-empty': true,
    'color-no-invalid-hex': true,
    'property-no-unknown': true,
    'selector-type-no-unknown': true,
    'selector-max-specificity': '0,3,1',
    'declaration-no-important': true,
  },
}
