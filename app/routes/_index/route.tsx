import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Freshness Tracker</h1>
        <p className={styles.text}>
          Know which perishable stock is fresh, close to expiry or expired, and
          have each fulfilled order use up the soonest-expiring batch first.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                required
              />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Batches with expiry dates</strong>. Record the quantity and
            expiration date of each batch on the product page.
          </li>
          <li>
            <strong>A freshness dashboard</strong>. See the status and earliest
            expiry of every product, filter what needs attention, and export the
            filtered list to CSV.
          </li>
          <li>
            <strong>First expired, first out</strong>. A fulfilled order takes
            stock from the soonest-expiring batch, and expired batches are never
            used.
          </li>
        </ul>
      </div>
    </div>
  );
}
