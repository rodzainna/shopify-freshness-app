import "@shopify/ui-extensions/preact";
import {
  type BatchFreshness,
  computeBatchFreshness,
  getShopToday,
  type FreshnessStatus,
} from "../../../shared/freshness";
import { render } from "preact";
import { useState } from "preact/hooks";

export default async () => {
  const { data } = await shopify.query<{ shop: { ianaTimezone: string } }>(`
    query GetShopTimezone {
      shop {
        ianaTimezone
      }
    }
  `);

  render(
    <Extension timezone={data?.shop.ianaTimezone ?? "UTC"} />,
    document.body,
  );
};

interface PanelBatch {
  id: string;
  quantity: number;
  restockedOn: string;
  expirationDate: string;
}

// interface FreshnessBatchNode {
//   id: string;
//   quantity: { value: string } | null;
//   restockedOn: { value: string } | null;
//   expirationDate: { value: string } | null;
// }

// const MOCK_BATCHES: PanelBatch[] = [
//   { id: "1", quantity: 12, restockedOn: "2026-09-10", expirationDate: "2026-09-14" },
//   { id: "2", quantity: 5, restockedOn: "2026-09-01", expirationDate: "2026-09-08" },
//   { id: "3", quantity: 20, restockedOn: "", expirationDate: "2026-10-01" },
// ];

const STATUS_TONE: Record<FreshnessStatus, "success" | "warning" | "critical"> =
  {
    Fresh: "success",
    "Use Soon": "warning",
    Expired: "critical",
  };

// function toPanelBatch(node: FreshnessBatchNode): PanelBatch {
//   return {
//     id: node.id,
//     quantity: Number(node.quantity?.value ?? 0),
//     restockedOn: node.restockedOn?.value ?? "",
//     expirationDate: node.expirationDate?.value ?? ""
//   };
// }

function getFreshness(
  expirationDate: string,
  today: string,
): BatchFreshness | null {
  if (!expirationDate) return null;

  try {
    return computeBatchFreshness(expirationDate, today);
  } catch {
    return null;
  }
}

function Extension({ timezone }: { timezone: string }) {
  const { data } = shopify;
  console.log({ data });
  const today = getShopToday(timezone, new Date());

  const [batches, setBatches] = useState<PanelBatch[]>([]);

  function updateBatch(id: string, changes: Partial<PanelBatch>) {
    setBatches((current) =>
      current.map((batch) =>
        batch.id === id ? { ...batch, ...changes } : batch,
      ),
    );
  }

  function removeBatch(id: string) {
    setBatches((current) => current.filter((batch) => batch.id !== id));
  }

  function addBatch() {
    setBatches((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        quantity: 0,
        restockedOn: "",
        expirationDate: "",
      },
    ]);
  }

  return (
    <s-admin-block heading="Freshness batches">
      <s-stack direction="block" gap="base">
        {batches.map((batch) => {
          const freshness = getFreshness(batch.expirationDate, today);

          return (
            <s-stack key={batch.id} direction="block" gap="base">
              <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="base">
                <s-number-field
                  label="Quantity"
                  value={String(batch.quantity)}
                  onChange={(event) =>
                    updateBatch(batch.id, {
                      quantity: Number(event.currentTarget.value),
                    })
                  }
                />
                <s-date-field
                  label="Expiry Date"
                  value={batch.expirationDate}
                  required
                  onChange={(event) =>
                    updateBatch(batch.id, {
                      expirationDate: event.currentTarget.value,
                    })
                  }
                />
                <s-date-field
                  label="Restocked On"
                  value={batch.restockedOn}
                  onChange={(event) =>
                    updateBatch(batch.id, {
                      restockedOn: event.currentTarget.value,
                    })
                  }
                />
              </s-grid>
              <s-grid
                gridTemplateColumns="repeat(4, 1fr)"
                gap="base"
                alignItems="start"
              >
                <s-button tone="critical" onClick={() => removeBatch(batch.id)}>
                  Remove
                </s-button>
                {freshness ? (
                  <s-badge tone={STATUS_TONE[freshness.status]}>
                    {freshness.status}: {freshness.daysRemaining}
                  </s-badge>
                ) : (
                  <s-badge tone="info">Enter an expiration date</s-badge>
                )}
              </s-grid>
            </s-stack>
          );
        })}
        <s-button onClick={addBatch}>Add batch</s-button>
      </s-stack>
    </s-admin-block>
  );
}
