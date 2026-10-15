"""Build recorded-project identities and sequence-specific price lookups offline.

Usage: python3 data/market-prices/build_project_knowledge.py [sales.csv] [output.json]
Identity discovery reads every named project in the latest twelve months before
price filtering. Prices use the same full-share and global outlier methodology
as build_market_tables.py. Neither a recorded identity nor a sale proves stock.
"""
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
TYPE_MAP = {
    "apartment": "Apartment", "villa": "Villa", "townhouse / attached villa": "Townhouse",
    "duplex": "Duplex", "penthouse": "Penthouse", "plot for villa": "Villa plot",
    "office": "Office", "retail": "Retail",
}
BEDS = {"studio": "Studio", "1 bed": "1 BR", "2 beds": "2 BR", "3 beds": "3 BR",
        "4 beds": "4 BR", "5 beds": "5+ BR", "5+ beds": "5+ BR", "6+ beds": "5+ BR"}
UNNAMED = {"", "private", "no project name", "all projects", "unclassified", "unknown", "n/a", "na", "not specified"}
# Short names are declared, never inferred by collapsing different phases.
ALIASES = {"Bab Al Qasr Residence 25": ["Bab Al Qasr 25", "Bab Al Qasr25", "Bab Alqasr25", "Bab Alqasr 25", "باب القصر 25", "باب القصر25"]}


def count_scope(rows, sequence=None, sale_type=None):
    mask = pd.Series(True, index=rows.index)
    if sequence:
        mask &= rows["Sale Sequence"].eq(sequence)
    if sale_type:
        mask &= rows["Sale Application Type"].eq(sale_type)
    return int(mask.sum())


def build(source):
    raw_bytes = source.read_bytes()
    rows = pd.read_csv(source, encoding="utf-8-sig")
    rows.columns = [column.strip() for column in rows.columns]
    rows["Date"] = pd.to_datetime(rows["Sale Application Date"], errors="raise")
    rows["Project"] = rows["Project Name"].fillna("").str.strip()
    rows["District"] = rows["District"].fillna("Not stated").str.strip().replace("", "Not stated")
    rows["Property Type"] = rows["Property Type"].fillna("Not stated")
    rows["Property Layout"] = rows["Property Layout"].fillna("Not stated")
    rows["Asset Class"] = rows["Asset Class"].fillna("Not stated")
    cutoff = rows["Date"].max()
    window_exclusive = cutoff - pd.DateOffset(months=12)
    year_start = pd.Timestamp(year=cutoff.year, month=1, day=1)
    periods = {
        "Last 3 months": (cutoff - pd.DateOffset(months=3) + pd.Timedelta(days=1), cutoff),
        "This year": (year_start, cutoff),
        "Last 12 months": (window_exclusive + pd.Timedelta(days=1), cutoff),
    }
    named = ~rows["Project"].str.lower().isin(UNNAMED)
    recent = rows[named & rows["Date"].gt(window_exclusive) & rows["Date"].le(cutoff)].copy()
    projects = {}
    for (area, name), group in recent.groupby(["District", "Project"], sort=True):
        primary = count_scope(group, "Primary", "off-plan")
        secondary = count_scope(group, "Secondary")
        ready = count_scope(group, "Primary", "ready")
        identity = json.dumps([area, name], ensure_ascii=False, separators=(",", ":"))
        homes = []
        for (property_type, asset_class), home in group.groupby(["Property Type", "Asset Class"], sort=True):
            homes.append({"type": TYPE_MAP.get(property_type, property_type), "propertyType": property_type, "assetClass": asset_class,
                          "bedrooms": sorted(set(home["Property Layout"].map(BEDS).fillna("Not stated"))),
                          "layouts": sorted(set(home["Property Layout"])), "observedSales": len(home),
                          "primaryOffPlanSales": count_scope(home, "Primary", "off-plan"),
                          "secondarySales": count_scope(home, "Secondary"), "primaryReadySales": count_scope(home, "Primary", "ready")})
        projects[(area, name)] = {"id": "project-knowledge:" + hashlib.sha256(identity.encode()).hexdigest()[:20],
                                  "name": name, "sourceName": name, "area": area, "aliases": ALIASES.get(name, []),
                                  "observedSales": len(group), "primaryOffPlanSales": primary, "secondarySales": secondary,
                                  "primaryReadySales": ready, "otherSales": len(group) - primary - secondary - ready,
                                  "priority": "primary-off-plan" if primary else "secondary" if secondary else "primary-ready" if ready else "other-recorded",
                                  "firstObservedSale": str(group["Date"].min().date()), "lastObservedSale": str(group["Date"].max().date()),
                                  "homeTypes": homes, "stats": []}

    # Metrics deliberately share the original table's cleaning scope: quantiles
    # use all dates and sales sequences before the recent-period restriction.
    metric = rows[(rows["Property Sold Share"] == 1)
                  & rows["Property Sold Area (SQM)"].gt(0)
                  & rows["Property Sale Price (AED)"].gt(0)
                  & rows["Sale Application Type"].isin(["off-plan", "ready"])].copy()
    metric["Type"] = metric["Property Type"].map(TYPE_MAP)
    metric = metric[metric["Type"].notna()].copy()
    metric["Bedrooms"] = metric["Property Layout"].map(BEDS).fillna("Not stated")
    metric["Size sqft"] = metric["Property Sold Area (SQM)"] * 10.7639
    metric["Price"] = metric["Property Sale Price (AED)"]
    metric["AED per sqft"] = metric["Price"] / metric["Size sqft"]
    grouped = metric.groupby(["District", "Type", "Bedrooms"])["AED per sqft"]
    low = grouped.transform(lambda values: values.quantile(0.01))
    high = grouped.transform(lambda values: values.quantile(0.99))
    metric = metric[metric["AED per sqft"].ge(low) & metric["AED per sqft"].le(high)].copy()
    metric = metric[~metric["Project"].str.lower().isin(UNNAMED) & metric["Date"].gt(window_exclusive)].copy()
    metric["Sale Type"] = metric["Sale Application Type"].map({"off-plan": "Off-plan", "ready": "Ready"})
    metric = metric[metric["Sale Sequence"].isin(["Primary", "Secondary"])].copy()
    keys = ["District", "Project", "Sale Sequence", "Sale Type", "Type", "Bedrooms"]
    for period, (start, end) in periods.items():
        sample = metric[metric["Date"].ge(start) & metric["Date"].le(end)]
        sample = pd.concat([sample, sample.assign(**{"Sale Sequence": "All"})])
        sample = pd.concat([sample, sample.assign(**{"Sale Type": "All"})])
        sample = pd.concat([sample, sample.assign(Bedrooms="All")])
        stats = sample.groupby(keys).agg(sales=("Price", "size"), averageAedPerSqft=("AED per sqft", "mean"),
                                        medianAedPerSqft=("AED per sqft", "median"), averagePriceAed=("Price", "mean"),
                                        medianPriceAed=("Price", "median"), averageSizeSqft=("Size sqft", "mean"),
                                        firstSale=("Date", "min"), lastSale=("Date", "max")).reset_index()
        for column in ["averageAedPerSqft", "medianAedPerSqft", "averagePriceAed", "medianPriceAed", "averageSizeSqft"]:
            stats[column] = stats[column].round(0).astype(int)
        stats["reliability"] = np.where(stats["sales"].ge(5), "OK", "Low sample")
        for row in stats.to_dict("records"):
            area, name = row.pop("District"), row.pop("Project")
            sequence, sale_type = row.pop("Sale Sequence"), row.pop("Sale Type")
            property_type, bedrooms = row.pop("Type"), row.pop("Bedrooms")
            row["firstSale"] = str(row["firstSale"].date())
            row["lastSale"] = str(row["lastSale"].date())
            stat = {"key": " | ".join([period, area, name, sequence, sale_type, property_type, bedrooms]),
                    "project": name, "area": area, "period": period, "periodStart": str(start.date()), "periodEnd": str(end.date()),
                    "saleSequence": sequence, "saleType": sale_type, "type": property_type, "bedrooms": bedrooms, **row}
            projects[(area, name)]["stats"].append(stat)
    project_list = sorted(projects.values(), key=lambda project: (0 if project["primaryOffPlanSales"] else 1 if project["secondarySales"] else 2, project["name"], project["area"]))
    primary = {project["name"] for project in project_list if project["primaryOffPlanSales"]}
    secondary = {project["name"] for project in project_list if project["secondarySales"]}
    ready = {project["name"] for project in project_list if project["primaryReadySales"]}
    coverage = {"projectCount": len({project["name"] for project in project_list}), "identityCount": len(project_list),
                "primaryOffPlanProjectCount": len(primary), "secondaryProjectCount": len(secondary),
                "primaryOffPlanOrSecondaryProjectCount": len(primary | secondary), "secondaryOnlyProjectCount": len(secondary - primary),
                "primaryReadyProjectCount": len(ready), "otherRecentProjectCount": len({project["name"] for project in project_list} - primary - secondary),
                "observedSales": len(recent), "statsRowCount": sum(len(project["stats"]) for project in project_list),
                "projectsWithoutPriceStats": sum(not project["stats"] for project in project_list)}
    return {"version": 1, "source": {"file": source.name, "sha256": hashlib.sha256(raw_bytes).hexdigest(),
                                      "url": "https://adrec.gov.ae/en/market-data", "commercialUse": False,
                                      "dataUpTo": str(cutoff.date()), "windowStart": str((window_exclusive + pd.Timedelta(days=1)).date()),
                                      "windowEnd": str(cutoff.date()), "sourceRows": len(rows), "countsAreRecordedRows": True,
                                      "duplicatesRetained": True, "identitiesBeforeMetricFilters": True,
                                      "periods": {name: {"start": str(start.date()), "end": str(end.date())} for name, (start, end) in periods.items()},
                                      "metricMethod": "Full shares; positive price and area; supported property types; ready/off-plan only; global district/type/bedroom 1st–99th percentile filter; rounded transaction-level means."},
            "coverage": coverage, "projects": project_list}


if __name__ == "__main__":
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "recent_sales.csv"
    output = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "project_knowledge.json"
    data = build(source)
    output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"source": data["source"]["file"], "dataUpTo": data["source"]["dataUpTo"], **data["coverage"]}, indent=2))
