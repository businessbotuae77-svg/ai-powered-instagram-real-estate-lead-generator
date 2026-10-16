"""Archive every recorded sale left out of the price figures, and flag retained
rows that need a human look, without changing the source export.

Usage: python3 data/market-prices/build_transaction_audit.py [sales.csv] [output_dir]
Outputs: transaction_exclusions.csv, transaction_flags.csv, transaction_audit.json

The exclusion rules are exactly those of build_market_tables.py and
build_project_knowledge.py (full shares, positive area and price, ready or
off-plan, supported home types, 1st-99th percentile AED/sqft per district,
type and bedrooms over all dates). Nothing here deletes or edits a sale: the
original recent_sales.csv stays the archive, and every exclusion can be
reproduced from its source line, rule and threshold.

Flags never exclude a row. Identical rows stay separate sales because the
export has no transaction ID, and a resale at the original developer price
may be a transfer of the same home, which the export cannot confirm.
"""
import hashlib
import json
from pathlib import Path
import sys

import pandas as pd

HERE = Path(__file__).resolve().parent
SQM_TO_SQFT = 10.7639
TYPE_MAP = {
    "apartment": "Apartment", "villa": "Villa", "townhouse / attached villa": "Townhouse",
    "duplex": "Duplex", "penthouse": "Penthouse", "plot for villa": "Villa plot",
    "office": "Office", "retail": "Retail",
}
BEDS = {"studio": "Studio", "1 bed": "1 BR", "2 beds": "2 BR", "3 beds": "3 BR",
        "4 beds": "4 BR", "5 beds": "5+ BR", "5+ beds": "5+ BR", "6+ beds": "5+ BR"}
FIELDS = ["Asset Class", "Property Type", "Sale Application Date", "Property Sold Area (SQM)",
          "Land Plot Ground Area (SQM)", "Property Layout", "District", "Community", "Project Name",
          "Property Sale Price (AED)", "Property Sold Share", "Rate (AED per SQM)",
          "Sale Application Type", "Sale Sequence"]
RULES = {
    "partial_share": "Property Sold Share must equal 1",
    "missing_or_zero_area": "Property Sold Area (SQM) must be > 0",
    "missing_or_zero_price": "Property Sale Price (AED) must be > 0",
    "not_ready_or_off_plan": "Sale Application Type must be off-plan or ready (court-mandated sales excluded)",
    "unsupported_property_type": "Property Type outside apartment, villa, townhouse, duplex, penthouse, villa plot, office, retail",
    "aed_per_sqft_below_p01": "AED/sqft below the 1st percentile of all sales with the same district, type and bedrooms",
    "aed_per_sqft_above_p99": "AED/sqft above the 99th percentile of all sales with the same district, type and bedrooms",
}
FLAGS = {
    "identical_row": "All 14 exported fields match another row (group_key); kept as separate sales because the export has no transaction ID",
    "resale_at_earlier_primary_price": "Resale with the same project, layout, area and price as an earlier primary sale (detail = that date); possibly the same home transferred at its original price, which the export cannot confirm",
    "area_far_from_layout_median": "Sold area more than twice or less than half the median for this project and layout (detail = median sqm and row count); the layout or home type may be mislabelled",
}


def fingerprint(row):
    # Raw field text, not parsed numbers: identical rows share one fingerprint.
    values = [str(row[field]) if pd.notna(row[field]) else "" for field in FIELDS]
    return hashlib.sha256(json.dumps(values, ensure_ascii=False).encode()).hexdigest()[:16]


def base(frame):
    return pd.DataFrame({
        "source_line": frame["source_line"], "row_sha256": frame["row_sha256"],
        "sale_date": frame["Sale Application Date"], "district": frame["District"],
        "project": frame["Project Name"], "property_type": frame["Property Type"], "layout": frame["Property Layout"],
        "sold_area_sqm": frame["Property Sold Area (SQM)"], "price_aed": frame["Property Sale Price (AED)"],
        "sold_share": frame["Property Sold Share"], "sale_application_type": frame["Sale Application Type"],
        "sale_sequence": frame["Sale Sequence"],
    })


def compact(frame):
    return pd.DataFrame({"source_line": frame["source_line"], "row_sha256": frame["row_sha256"]})


def build(source):
    raw = source.read_bytes()
    rows = pd.read_csv(source, encoding="utf-8-sig", dtype={"Project Name": str, "Community": str, "District": str})
    rows.columns = [column.strip() for column in rows.columns]
    # Header is line 1; the export has no embedded newlines (checked by row count below).
    rows["source_line"] = rows.index + 2
    rows["row_sha256"] = rows.apply(fingerprint, axis=1)
    exclusions = []

    def exclude(mask, reason):
        part = base(rows[mask & ~rows["source_line"].isin(done)])
        part["reason"] = reason
        exclusions.append(part)
        done.update(part["source_line"])

    done = set()
    # Same order as the build scripts' combined filter; each row gets its first reason.
    exclude(rows["Property Sold Share"].ne(1), "partial_share")
    exclude(~rows["Property Sold Area (SQM)"].gt(0), "missing_or_zero_area")
    exclude(~rows["Property Sale Price (AED)"].gt(0), "missing_or_zero_price")
    exclude(~rows["Sale Application Type"].isin(["off-plan", "ready"]), "not_ready_or_off_plan")
    exclude(rows["Property Type"].map(TYPE_MAP).isna(), "unsupported_property_type")

    kept = rows[~rows["source_line"].isin(done)].copy()
    kept["Type"] = kept["Property Type"].map(TYPE_MAP)
    kept["Bedrooms"] = kept["Property Layout"].map(BEDS).fillna("Not stated")
    kept["AED per sqft"] = kept["Property Sale Price (AED)"] / (kept["Property Sold Area (SQM)"] * SQM_TO_SQFT)
    grouped = kept.groupby(["District", "Type", "Bedrooms"])["AED per sqft"]
    kept["p01"] = grouped.transform(lambda values: values.quantile(0.01))
    kept["p99"] = grouped.transform(lambda values: values.quantile(0.99))
    for reason, mask in [("aed_per_sqft_below_p01", kept["AED per sqft"] < kept["p01"]),
                         ("aed_per_sqft_above_p99", kept["AED per sqft"] > kept["p99"])]:
        part = base(kept[mask])
        part["reason"] = reason
        part["aed_per_sqft"] = kept.loc[mask, "AED per sqft"].round(2)
        part["threshold_low"] = kept.loc[mask, "p01"].round(2)
        part["threshold_high"] = kept.loc[mask, "p99"].round(2)
        part["percentile_group"] = kept.loc[mask, "District"] + " | " + kept.loc[mask, "Type"] + " | " + kept.loc[mask, "Bedrooms"]
        exclusions.append(part)
        done.update(part["source_line"])
    excluded = pd.concat(exclusions, ignore_index=True).sort_values("source_line")

    # Flags on rows that stay in the figures.
    used = rows[~rows["source_line"].isin(done)].copy()
    flags = []
    identical = rows[rows.duplicated(FIELDS, keep=False)]
    sizes = identical.groupby("row_sha256")["source_line"].transform("size")
    part = compact(identical)
    part["flag"] = "identical_row"
    part["group_key"] = identical["row_sha256"]
    part["detail"] = "group_size=" + sizes.astype(str)
    flags.append(part)

    named = rows[rows["Project Name"].fillna("").str.strip().ne("")].copy()
    named["unit_key"] = named["District"].astype(str) + "|" + named["Project Name"].astype(str) + "|" + named["Property Layout"].astype(str) + "|" + \
        named["Property Sold Area (SQM)"].astype(str) + "|" + named["Property Sale Price (AED)"].astype(str)
    primary = named[named["Sale Sequence"].eq("Primary")].groupby("unit_key")["Sale Application Date"].min()
    secondary = named[named["Sale Sequence"].eq("Secondary") & named["unit_key"].isin(primary.index)]
    secondary = secondary[secondary["Sale Application Date"] >= secondary["unit_key"].map(primary)]
    part = compact(secondary)
    part["flag"] = "resale_at_earlier_primary_price"
    part["group_key"] = secondary["unit_key"].map(lambda key: hashlib.sha256(key.encode()).hexdigest()[:16])
    part["detail"] = "first_primary_sale=" + secondary["unit_key"].map(primary)
    flags.append(part)

    layouts = named[named["Property Sold Area (SQM)"].gt(0)].copy()
    stats = layouts.groupby(["District", "Project Name", "Property Type", "Property Layout"])["Property Sold Area (SQM)"].agg(["median", "size"])
    layouts = layouts.join(stats, on=["District", "Project Name", "Property Type", "Property Layout"])
    odd = layouts[layouts["size"].ge(5) & ~layouts["Property Layout"].eq("unclassified") &
                  ((layouts["Property Sold Area (SQM)"] > 2 * layouts["median"]) | (layouts["Property Sold Area (SQM)"] < 0.5 * layouts["median"]))]
    part = compact(odd)
    part["flag"] = "area_far_from_layout_median"
    part["group_key"] = ""
    part["detail"] = "layout_median_sqm=" + odd["median"].round(2).astype(str) + ";rows=" + odd["size"].astype(str)
    flags.append(part)
    flagged = pd.concat(flags, ignore_index=True)
    flagged["in_price_figures"] = ~flagged["source_line"].isin(done)
    flagged = flagged.sort_values(["source_line", "flag"])

    counts = excluded["reason"].value_counts().to_dict()
    summary = {
        "version": 1, "source": {"file": source.name, "sha256": hashlib.sha256(raw).hexdigest(), "rows": len(rows),
                                 "dataUpTo": str(pd.to_datetime(rows["Sale Application Date"]).max().date())},
        "excludedRows": int(len(excluded)), "excludedByReason": {key: int(value) for key, value in sorted(counts.items())},
        "rowsInPriceFigures": int(len(used)), "flaggedRows": int(flagged["source_line"].nunique()),
        "flagsByType": {key: int(value) for key, value in sorted(flagged["flag"].value_counts().to_dict().items())},
        "exclusionRules": RULES, "flagMeanings": FLAGS,
        "note": "Exclusions mirror build_market_tables.py and build_project_knowledge.py; flags never exclude a row. The source export is not modified.",
    }
    return excluded, flagged, summary


if __name__ == "__main__":
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "recent_sales.csv"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE
    excluded, flagged, summary = build(source)
    excluded.to_csv(out / "transaction_exclusions.csv", index=False)
    flagged.to_csv(out / "transaction_flags.csv", index=False)
    (out / "transaction_audit.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
