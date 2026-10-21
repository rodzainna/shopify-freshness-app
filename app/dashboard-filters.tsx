import { useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLocation,
  useNavigate,
  useNavigation,
} from "react-router";

import {
  type DashboardFilters,
  FILTER_PARAMS,
} from "../shared/dashboard-filters";
import type { FilterOptions } from "./routes/app.filter-options";

const SEARCH_DELAY_MS = 300;

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

  function clearAll() {
    // A search still waiting to run would bring its text back
    clearTimeout(timer.current);
    timer.current = undefined;
    setText("");
    update((params) => {
      for (const name of Object.values(FILTER_PARAMS)) params.delete(name);
    });
  }

  return { text, search, setFilter, clearAll };
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

  return (
    <s-stack slot="filters" direction="inline" gap="small-200">
      <s-search-field
        label="Search products"
        labelAccessibilityVisibility="exclusive"
        placeholder="Search products"
        value={controls.text}
        onInput={(event) => controls.search(event.currentTarget.value)}
      />
      <FilterButton
        id="type-filter"
        label="Type"
        options={options.data?.types}
        selected={filters.types}
        onOpen={loadOptions}
        onApply={(values) => controls.setFilter(FILTER_PARAMS.type, values)}
      />
      <FilterButton
        id="vendor-filter"
        label="Vendor"
        options={options.data?.vendors}
        selected={filters.vendors}
        onOpen={loadOptions}
        onApply={(values) => controls.setFilter(FILTER_PARAMS.vendor, values)}
      />
    </s-stack>
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
  options: string[] | undefined;
  selected: string[];
  onOpen: () => void;
  onApply: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState(selected);
  // Keep selected values that aren't in the list (renamed, or past its limit) so they can be unticked
  const choices = [...new Set([...(options ?? []), ...selected])];

  return (
    <>
      <s-button
        commandFor={id}
        onClick={() => {
          // Start from what's applied, dropping changes from a dismissed popover
          setDraft(selected);
          onOpen();
        }}
      >
        {buttonText(label, selected)}
      </s-button>
      <s-popover id={id}>
        <s-box padding="base">
          <s-stack gap="base">
            {options === undefined && (
              <s-spinner accessibilityLabel="Loading" />
            )}
            <s-choice-list
              label={label}
              labelAccessibilityVisibility="exclusive"
              multiple
              onChange={(event) => setDraft([...event.currentTarget.values])}
            >
              {choices.map((choice) => (
                <s-choice
                  key={choice}
                  value={choice}
                  // React 18 renders false as the string "false", which counts as set
                  selected={draft.includes(choice) || undefined}
                >
                  {choice}
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
