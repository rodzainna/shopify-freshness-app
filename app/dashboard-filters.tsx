import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import {
  type DashboardFilters,
  FILTER_PARAMS,
} from "../shared/dashboard-filters";

const SEARCH_DELAY_MS = 300;

type ChoiceListElement = HTMLElement & { values: string[] };

/** Search field and filter buttons for the table's filters slot. */
export function DashboardFilterBar({
  filters,
  types,
  vendors,
}: {
  filters: DashboardFilters;
  types: string[];
  vendors: string[];
}) {
  return (
    <s-stack slot="filters" direction="inline" gap="small-200">
      <SearchField search={filters.search} />
      <FilterButton
        id="type-filter"
        label="Type"
        param={FILTER_PARAMS.type}
        options={types}
        selected={filters.types}
      />
      <FilterButton
        id="vendor-filter"
        label="Vendor"
        param={FILTER_PARAMS.vendor}
        options={vendors}
        selected={filters.vendors}
      />
    </s-stack>
  );
}

function SearchField({ search }: { search: string }) {
  const [, setSearchParams] = useSearchParams();
  const [text, setText] = useState(search);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // Follow the URL (Back, Clear filters) unless a search is about to run
  useEffect(() => {
    if (!timer.current) setText(search);
  }, [search]);

  useEffect(() => () => clearTimeout(timer.current), []);

  function onInput(event: Event) {
    const value = (event.currentTarget as HTMLInputElement).value;
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      // Replace, so each pause in typing doesn't add a Back step
      setSearchParams(
        (params) => {
          if (value.trim()) params.set(FILTER_PARAMS.search, value.trim());
          else params.delete(FILTER_PARAMS.search);
          return params;
        },
        { replace: true },
      );
    }, SEARCH_DELAY_MS);
  }

  return (
    <s-search-field
      label="Search products"
      labelAccessibilityVisibility="exclusive"
      placeholder="Search products"
      value={text}
      onInput={onInput}
    />
  );
}

function FilterButton({
  id,
  label,
  param,
  options,
  selected,
}: {
  id: string;
  label: string;
  param: string;
  options: string[];
  selected: string[];
}) {
  const [, setSearchParams] = useSearchParams();
  const [draft, setDraft] = useState(selected);

  useEffect(() => setDraft(selected), [selected]);

  function apply(values: string[]) {
    setSearchParams((params) => {
      params.delete(param);
      for (const value of values) params.append(param, value);
      return params;
    });
  }

  return (
    <>
      <s-button commandFor={id}>{buttonText(label, selected)}</s-button>
      <s-popover id={id}>
        <s-box padding="base">
          <s-stack gap="base">
            <s-choice-list
              label={label}
              labelAccessibilityVisibility="exclusive"
              multiple
              onChange={(event) =>
                setDraft([...(event.currentTarget as ChoiceListElement).values])
              }
            >
              {options.map((option) => (
                <s-choice
                  key={option}
                  value={option}
                  // React 18 renders false as the string "false", which counts as set
                  selected={draft.includes(option) || undefined}
                >
                  {option}
                </s-choice>
              ))}
            </s-choice-list>
            <s-stack direction="inline" gap="small-200">
              <s-button
                variant="primary"
                commandFor={id}
                command="--hide"
                onClick={() => apply(draft)}
              >
                Apply
              </s-button>
              <s-button
                commandFor={id}
                command="--hide"
                onClick={() => apply([])}
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
