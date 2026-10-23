import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLocation,
  useNavigate,
  useNavigation,
} from "react-router";

import {
  type DashboardFilters,
  type DashboardSort,
  EXPIRY_PRESETS,
  type ExpiryFilter,
  FILTER_PARAMS,
  SORTS,
  STATUS_FILTERS,
  STOCK_FILTERS,
  applyExpiry,
  applySort,
  clearFilters,
  isDashboardSort,
  isExpiryPreset,
  parseSort,
} from "../shared/dashboard-filters";
import { isCalendarDate } from "../shared/freshness";
import type { FilterOptions } from "./routes/app.filter-options";

const SEARCH_DELAY_MS = 300;

interface Option {
  value: string;
  label: string;
}

const STATUS_OPTIONS = toOptions(STATUS_FILTERS);
const STOCK_OPTIONS = toOptions(STOCK_FILTERS);
const SORT_OPTIONS = toOptions(SORTS);
const CUSTOM_RANGE = "custom";
const EXPIRY_OPTIONS = [
  ...toOptions(EXPIRY_PRESETS),
  { value: CUSTOM_RANGE, label: "Custom range" },
];

type UpdateParams = (params: URLSearchParams) => void;

/**
 * The dashboard's search text and URL updates. Every update starts from the
 * newest URL, including a navigation still loading, so quick changes in a row
 * build on each other instead of overwriting each other.
 */
export function useDashboardFilters(filters: DashboardFilters) {
  const navigate = useNavigate();
  const location = useLocation();
  const navigation = useNavigation();
  const latestSearch = useRef(location.search);
  latestSearch.current = navigation.location?.search ?? location.search;

  // From the newest URL, so a sort still loading shows as chosen
  const sort = parseSort(new URLSearchParams(latestSearch.current));

  const [text, setText] = useState(filters.search);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // Follow the URL (Back, Clear filters), but keep what's typed when it matches
  useEffect(() => {
    if (timer.current) return;
    setText((typed) =>
      typed.trim() === filters.search ? typed : filters.search,
    );
  }, [filters.search]);

  useEffect(() => () => clearTimeout(timer.current), []);

  function update(change: UpdateParams, replace = false) {
    const params = new URLSearchParams(latestSearch.current);
    change(params);
    latestSearch.current = `?${params}`;
    navigate({ search: latestSearch.current }, { replace });
  }

  function search(value: string) {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      // Replace, so each pause in typing doesn't add a Back step
      update((params) => {
        if (value.trim()) params.set(FILTER_PARAMS.search, value.trim());
        else params.delete(FILTER_PARAMS.search);
      }, true);
    }, SEARCH_DELAY_MS);
  }

  function setFilter(param: string, values: string[]) {
    update((params) => {
      params.delete(param);
      for (const value of values) params.append(param, value);
    });
  }

  function setExpiry(expiry: ExpiryFilter | null) {
    update((params) => applyExpiry(params, expiry));
  }

  function setSort(next: DashboardSort) {
    if (next !== sort) update((params) => applySort(params, next));
  }

  function clearAll() {
    // A search still waiting to run would bring its text back
    clearTimeout(timer.current);
    timer.current = undefined;
    setText("");
    update(clearFilters);
  }

  return { text, sort, search, setFilter, setExpiry, setSort, clearAll };
}

export type DashboardFilterControls = ReturnType<typeof useDashboardFilters>;

/** Search field and filter buttons for the table's filters slot. */
export function DashboardFilterBar({
  filters,
  controls,
}: {
  filters: DashboardFilters;
  controls: DashboardFilterControls;
}) {
  const options = useFetcher<FilterOptions>();
  // Fetched once, the first time a filter opens, so searches don't refetch them
  function loadOptions() {
    if (options.state === "idle" && !options.data) {
      options.load("/app/filter-options");
    }
  }

  const searchField = useLiveProperty("s-search-field", "value", controls.text);
  const trackedBox = useLiveProperty("s-checkbox", "checked", filters.tracked);

  return (
    <s-stack slot="filters" gap="small-200">
      <s-search-field
        ref={searchField}
        label="Search products"
        labelAccessibilityVisibility="exclusive"
        placeholder="Search products"
        onInput={(event) => controls.search(event.currentTarget.value)}
      />
      {/* Filters on the left; the tracked toggle and sort on the right */}
      <s-stack
        direction="inline"
        justifyContent="space-between"
        alignItems="center"
        gap="small-200"
      >
        <s-stack direction="inline" gap="small-200">
          <FilterButton
            id="status-filter"
            label="Status"
            options={STATUS_OPTIONS}
            selected={filters.statuses}
            onApply={(values) =>
              controls.setFilter(FILTER_PARAMS.status, values)
            }
          />
          <FilterButton
            id="stock-filter"
            label="Stock"
            options={STOCK_OPTIONS}
            selected={filters.stock}
            onApply={(values) =>
              controls.setFilter(FILTER_PARAMS.stock, values)
            }
          />
          <FilterButton
            id="type-filter"
            label="Type"
            options={options.data?.types.map(sameLabel)}
            selected={filters.types}
            onOpen={loadOptions}
            onApply={(values) => controls.setFilter(FILTER_PARAMS.type, values)}
          />
          <FilterButton
            id="vendor-filter"
            label="Vendor"
            options={options.data?.vendors.map(sameLabel)}
            selected={filters.vendors}
            onOpen={loadOptions}
            onApply={(values) =>
              controls.setFilter(FILTER_PARAMS.vendor, values)
            }
          />
          <ExpiryFilterButton
            expiry={filters.expiry}
            onApply={controls.setExpiry}
          />
        </s-stack>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-checkbox
            ref={trackedBox}
            label="Tracked only"
            onChange={(event) =>
              controls.setFilter(
                FILTER_PARAMS.tracked,
                event.currentTarget.checked ? ["1"] : [],
              )
            }
          />
          <SortButton sort={controls.sort} onSort={controls.setSort} />
        </s-stack>
      </s-stack>
    </s-stack>
  );
}

const SORT_POPOVER_ID = "sort-popover";

function SortButton({
  sort,
  onSort,
}: {
  sort: DashboardSort;
  onSort: (sort: DashboardSort) => void;
}) {
  const [draft, setDraft] = useState<string[]>([sort]);

  return (
    <>
      <s-button
        icon="sort"
        commandFor={SORT_POPOVER_ID}
        accessibilityLabel={`Sort: ${SORTS[sort]}`}
        // Start from what's applied, dropping a choice from a dismissed popover
        onClick={() => setDraft([sort])}
      >
        {SORTS[sort]}
      </s-button>
      <ChoicePopover
        id={SORT_POPOVER_ID}
        label="Sort by"
        showLabel
        choices={SORT_OPTIONS}
        draft={draft}
        onDraft={setDraft}
        onApply={() => {
          const [value] = draft;
          if (value && isDashboardSort(value)) onSort(value);
        }}
      />
    </>
  );
}

function FilterButton({
  id,
  label,
  options,
  selected,
  onOpen,
  onApply,
}: {
  id: string;
  label: string;
  // undefined until loaded
  options: Option[] | undefined;
  selected: string[];
  onOpen?: () => void;
  onApply: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState(selected);
  // Keep selected values that aren't in the list (renamed, or past its limit) so they can be unticked
  const listed = new Set(options?.map(({ value }) => value));
  const choices = [
    ...(options ?? []),
    ...selected.filter((value) => !listed.has(value)).map(sameLabel),
  ];

  return (
    <>
      <s-button
        commandFor={id}
        onClick={() => {
          // Start from what's applied, dropping changes from a dismissed popover
          setDraft(selected);
          onOpen?.();
        }}
      >
        {buttonText(
          label,
          selected.map((value) => labelOf(choices, value)),
        )}
      </s-button>
      <ChoicePopover
        id={id}
        label={label}
        choices={choices}
        loading={options === undefined}
        multiple
        draft={draft}
        onDraft={setDraft}
        onApply={() => onApply(draft)}
        onClear={() => onApply([])}
      />
    </>
  );
}

const EXPIRY_POPOVER_ID = "expiry-filter";

function ExpiryFilterButton({
  expiry,
  onApply,
}: {
  expiry: ExpiryFilter | null;
  onApply: (expiry: ExpiryFilter | null) => void;
}) {
  const [choice, setChoice] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const fromField = useLiveProperty("s-date-field", "value", from);
  const toField = useLiveProperty("s-date-field", "value", to);

  // Start from what's applied, dropping changes from a dismissed popover
  function open() {
    if (!expiry) setChoice([]);
    else setChoice(["preset" in expiry ? expiry.preset : CUSTOM_RANGE]);
    setFrom(expiry && !("preset" in expiry) ? (expiry.from ?? "") : "");
    setTo(expiry && !("preset" in expiry) ? (expiry.to ?? "") : "");
  }

  function apply() {
    const [value] = choice;
    if (value && isExpiryPreset(value)) {
      onApply({ preset: value });
    } else if (value === CUSTOM_RANGE && (from || to)) {
      onApply({ from: from || null, to: to || null });
    } else {
      onApply(null);
    }
  }

  return (
    <>
      <s-button commandFor={EXPIRY_POPOVER_ID} onClick={open}>
        {expiryButtonText(expiry)}
      </s-button>
      <ChoicePopover
        id={EXPIRY_POPOVER_ID}
        label="Expiry"
        choices={EXPIRY_OPTIONS}
        draft={choice}
        onDraft={setChoice}
        onApply={apply}
        onClear={() => onApply(null)}
        // A custom range needs a real date; Clear removes the filter
        applyDisabled={
          choice[0] === CUSTOM_RANGE &&
          ((!from && !to) || !isDateOrEmpty(from) || !isDateOrEmpty(to))
        }
      >
        {choice[0] === CUSTOM_RANGE && (
          <s-stack gap="small-200">
            <s-date-field
              ref={fromField}
              label="From"
              onChange={(event) => setFrom(event.currentTarget.value)}
            />
            <s-date-field
              ref={toField}
              label="To"
              onChange={(event) => setTo(event.currentTarget.value)}
            />
          </s-stack>
        )}
      </ChoicePopover>
    </>
  );
}

function isDateOrEmpty(value: string): boolean {
  return value === "" || isCalendarDate(value);
}

// "Expiry", "Expiry: Next 7 days" or "Expiry: 2026-10-01 – 2026-10-31"
function expiryButtonText(expiry: ExpiryFilter | null): string {
  if (!expiry) return "Expiry";
  if ("preset" in expiry) return `Expiry: ${EXPIRY_PRESETS[expiry.preset]}`;
  if (expiry.from && expiry.to) return `Expiry: ${expiry.from} – ${expiry.to}`;
  return expiry.from
    ? `Expiry: from ${expiry.from}`
    : `Expiry: until ${expiry.to}`;
}

// A choice list that applies only on Apply, so moving through it loads nothing
function ChoicePopover({
  id,
  label,
  showLabel = false,
  choices,
  loading = false,
  multiple = false,
  draft,
  onDraft,
  onApply,
  onClear,
  applyDisabled = false,
  children,
}: {
  id: string;
  label: string;
  showLabel?: boolean;
  choices: Option[];
  loading?: boolean;
  multiple?: boolean;
  draft: string[];
  onDraft: (values: string[]) => void;
  onApply: () => void;
  onClear?: () => void;
  applyDisabled?: boolean;
  // Extra fields under the choices
  children?: ReactNode;
}) {
  const choiceList = useLiveProperty("s-choice-list", "values", draft);

  return (
    <s-popover id={id}>
      <s-box padding="base">
        <s-stack gap="base">
          {loading && <s-spinner accessibilityLabel="Loading" />}
          <s-choice-list
            ref={choiceList}
            label={label}
            labelAccessibilityVisibility={showLabel ? undefined : "exclusive"}
            multiple={multiple || undefined}
            onChange={(event) => onDraft([...event.currentTarget.values])}
          >
            {choices.map((choice) => (
              <s-choice key={choice.value} value={choice.value}>
                {choice.label}
              </s-choice>
            ))}
          </s-choice-list>
          {children}
          <s-stack direction="inline" gap="small-200">
            <s-button
              variant="primary"
              commandFor={id}
              command="--hide"
              disabled={applyDisabled || undefined}
              onClick={onApply}
            >
              Apply
            </s-button>
            {onClear && (
              <s-button commandFor={id} command="--hide" onClick={onClear}>
                Clear
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-box>
    </s-popover>
  );
}

// "Type", "Type: Dairy" or "Type: 2 selected"
function buttonText(label: string, selected: string[]) {
  if (selected.length === 0) return label;
  if (selected.length === 1) return `${label}: ${selected[0]}`;
  return `${label}: ${selected.length} selected`;
}

function toOptions(labels: Record<string, string>): Option[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

// Types and vendors are shown as they're stored
function sameLabel(value: string): Option {
  return { value, label: value };
}

function labelOf(options: Option[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * React 18 passes props to web components as attributes, and Polaris reads
 * `value`, `checked` and `selected` attributes as the starting state only.
 * This sets the live property instead, after every render. The tag types the ref.
 */
function useLiveProperty<
  Tag extends keyof HTMLElementTagNameMap,
  Name extends keyof HTMLElementTagNameMap[Tag],
>(_tag: Tag, name: Name, value: HTMLElementTagNameMap[Tag][Name]) {
  const ref = useRef<HTMLElementTagNameMap[Tag]>(null);
  useEffect(() => {
    if (ref.current && !sameValue(ref.current[name], value)) {
      ref.current[name] = value;
    }
  });
  return ref;
}

// Arrays by contents, so setting the same choices again is a no-op
function sameValue(current: unknown, next: unknown) {
  if (!Array.isArray(next)) return current === next;
  return (
    Array.isArray(current) &&
    current.length === next.length &&
    next.every((value, index) => current[index] === value)
  );
}
