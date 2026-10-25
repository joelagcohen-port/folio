type Row = Record<string, any>;

const normalize = (value: unknown) => typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';

// Shared by normal Plaid sync, rule application, and autonomy candidate checks.
export function categorizationRuleMatches(row: Row, rule: Row): boolean {
  const needle = normalize(rule.match_text);
  const fields = rule.match_field === 'any'
    ? [row.name, row.merchant_name, row.original_description]
    : [row[rule.match_field]];
  return fields.some((value) => {
    const candidate = normalize(value);
    if (!candidate) return false;
    if (rule.match_type === 'exact') return candidate === needle;
    if (rule.match_type === 'prefix') return candidate.startsWith(needle);
    return candidate.includes(needle);
  });
}
