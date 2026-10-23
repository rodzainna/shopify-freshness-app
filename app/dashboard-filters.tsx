import { useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLocation,
  useNavigate,
  useNavigation,
} from "react-router";

import {
  type DashboardFilters,
  type DashboardSort,
  FILTER_PARAMS,
  SORTS,
  STATUS_FILTERS,
  STOCK_FILTERS,
  applySort,
  clearFilters,
  isDashboardSort,
  parseDashboardFilters,
} from "../shared/dashboard-filters";
import type { FilterOptions } from "./routes/app.filter-options";

const SEARCH_DELAY_MS = 300;

interface Option {
  value: string;
  label: string;
}

const STATUS_OPTIONS = toOptions(STATUS_FILTERS);
const STOCK_OPTIONS = toOptions(STOCK_FILTERS);
const SORT_OPTIONS = toOptions(SORTS);

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

  const [text, setText] = useState(filters.search);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // A sort picked in the last moment, before its navigation starts
  const [sortDraft, setSortDraft] = useState<DashboardSort | null>(null);
  const sortTimer = useRef<ReturnType<typeof setTimeout>>();

  // Follow the URL (Back, Clear filters), but keep what's typed when it matches
  useEffect(() => {
    if (timer.current) return;
    setText((typed) =>
      typed.trim() === filters.search ? typed : filters.search,
    );
  }, [filters.search]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(sortTimer.current);
    },
    [],
  );

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

  // Waits like search, so arrowing through the choices loads only the last one
  function setSort(sort: DashboardSort) {
    setSortDraft(sort);
    clearTimeout(sortTimer.current);
    sortTimer.current = setTimeout(() => {
      sortTimer.current = undefined;
      setSortDraft(null);
      update((params) => applySort(params, sort));
    }, SEARCH_DELAY_MS);
  }

  function clearAll() {
    // A search still waiting to run would bring its text back
    clearTimeout(timer.current);
    timer.current = undefined;
    setText("");
    update(clearFilters);
  }

  // From the newest URL, so a cancelled navigation can't leave a stale sort shown
  const sort =
    sortDraft ??
    parseDashboardFilters(new URLSearchParams(latestSearch.current)).sort;

  return { text, sort, search, setFilter, setSort, clearAll };
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
    <s-stack slot="filters" direction="inline" gap="small-200">
      <s-search-field
        ref={searchField}
        label="Search products"
        labelAccessibilityVisibility="exclusive"
        placeholder="Search products"
        onInput={(event) => controls.search(event.currentTarget.value)}
      />
      <FilterButton
        id="status-filter"
        label="Status"
        options={STATUS_OPTIONS}
        selected={filters.statuses}
        onApply={(values) => controls.setFilter(FILTER_PARAMS.status, values)}
      />
      <FilterButton
        id="stock-filter"
        label="Stock"
        options={STOCK_OPTIONS}
        selected={filters.stock}
        onApply={(values) => controls.setFilter(FILTER_PARAMS.stock, values)}
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
        onApply={(values) => controls.setFilter(FILTER_PARAMS.vendor, values)}
      />
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
  );
}

const SORT_POPOVER_ID = "sort-popover";

// Applies a choice at once; the popover stays open until a click outside
function SortButton({
  sort,
  onSort,
}: {
  sort: DashboardSort;
  onSort: (sort: DashboardSort) => void;
}) {
  const choiceList = useLiveProperty("s-choice-list", "values", [sort]);

  return (
    <>
      <s-button
        icon="sort"
        commandFor={SORT_POPOVER_ID}
        accessibilityLabel={`Sort: ${SORTS[sort]}`}
      >
        {SORTS[sort]}
      </s-button>
      <s-popover id={SORT_POPOVER_ID}>
        <s-box padding="base">
          <s-choice-list
            ref={choiceList}
            label="Sort by"
            onChange={(event) => {
              const [value] = event.currentTarget.values;
              if (value && isDashboardSort(value)) onSort(value);
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <s-choice key={option.value} value={option.value}>
                {option.label}
              </s-choice>
            ))}
          </s-choice-list>
        </s-box>
      </s-popover>
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
  const choiceList = useLiveProperty("s-choice-list", "values", draft);
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
      <s-popover id={id}>
        <s-box padding="base">
          <s-stack gap="base">
            {options === undefined && (
              <s-spinner accessibilityLabel="Loading" />
            )}
            <s-choice-list
              ref={choiceList}
              label={label}
              labelAccessibilityVisibility="exclusive"
              multiple
              onChange={(event) => setDraft([...event.currentTarget.values])}
            >
              {choices.map((choice) => (
                <s-choice key={choice.value} value={choice.value}>
                  {choice.label}
                </s-choice>
              ))}
            </s-choice-list>
            <s-stack direction="inline" gap="small-200">
              <s-button
                variant="primary"
                commandFor={id}
                command="--hide"
                onClick={() => onApply(draft)}
              >
                Apply
              </s-button>
              <s-button
                commandFor={id}
                command="--hide"
                onClick={() => onApply([])}
              >
                Clear
              </s-button>
            </s-stack>
          </s-stack>
        </s-box>
      </s-popover>
    </>
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
