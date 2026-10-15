"""
Build pre-calculated Abu Dhabi price tables from the raw sales CSV.
The bot only looks numbers up — every figure here is computed once by this script.

Usage:  python3 build_market_tables.py recent_sales.csv
Outputs: quarterly_prices.csv, period_prices.csv, build_report.txt
Re-run whenever you get a new sales file; it rebuilds everything from scratch.
"""
import sys
import pandas as pd
import numpy as np

SQM_TO_SQFT = 10.7639
MIN_SALES = 5  # below this, figures are kept but marked "Low sample"

src = sys.argv[1] if len(sys.argv) > 1 else "recent_sales.csv"
df = pd.read_csv(src, encoding="utf-8-sig")
df.columns = [c.strip() for c in df.columns]
report = [f"Source rows: {len(df)}"]

# ---------- clean ----------
df["Date"] = pd.to_datetime(df["Sale Application Date"])
# Identical rows are kept on purpose: the file has no unit ID, and most identical rows are
# same-day developer (primary, off-plan) sales of identical units, i.e. real separate sales.
report.append(f"Identical rows kept as separate sales: {df.duplicated().sum()}")

keep = (
    (df["Property Sold Share"] == 1)
    & df["Property Sold Area (SQM)"].gt(0)
    & df["Property Sale Price (AED)"].gt(0)
    & df["Sale Application Type"].isin(["off-plan", "ready"])  # court-mandated sales excluded
)
report.append(f"Excluded (partial share, no area/price, or court-mandated): {(~keep).sum()}")
df = df[keep].copy()

TYPE_MAP = {
    "apartment": "Apartment", "villa": "Villa", "townhouse / attached villa": "Townhouse",
    "duplex": "Duplex", "penthouse": "Penthouse", "plot for villa": "Villa plot",
    "office": "Office", "retail": "Retail",
}
df["Type"] = df["Property Type"].map(TYPE_MAP)
report.append(f"Excluded (other property types: farms, complexes, other plots...): {df['Type'].isna().sum()}")
df = df[df["Type"].notna()].copy()

BEDS = {"studio": "Studio", "1 bed": "1 BR", "2 beds": "2 BR", "3 beds": "3 BR",
        "4 beds": "4 BR", "5 beds": "5+ BR", "5+ beds": "5+ BR", "6+ beds": "5+ BR"}
df["Bedrooms"] = df["Property Layout"].map(BEDS).fillna("Not stated")

df["Size sqft"] = df["Property Sold Area (SQM)"] * SQM_TO_SQFT
df["Price"] = df["Property Sale Price (AED)"]
df["AED per sqft"] = df["Price"] / df["Size sqft"]
df["Sale Type"] = df["Sale Application Type"].map({"off-plan": "Off-plan", "ready": "Ready"})
df["Project"] = df["Project Name"].fillna("No project name")

# flag data errors: price per sqft outside 1st–99th percentile for the same district + type + bedrooms
g = df.groupby(["District", "Type", "Bedrooms"])["AED per sqft"]
lo, hi = g.transform(lambda s: s.quantile(0.01)), g.transform(lambda s: s.quantile(0.99))
df["Outlier"] = (df["AED per sqft"] < lo) | (df["AED per sqft"] > hi)
report.append(f"Flagged as extreme price per sqft and left out of figures: {df['Outlier'].sum()}")
df = df[~df["Outlier"]].copy()
report.append(f"Sales used in the tables: {len(df)}")

q = df["Date"].dt.quarter
df["Quarter"] = df["Date"].dt.year.astype(str) + "-Q" + q.astype(str)
DATA_END = df["Date"].max()
YEAR_START = pd.Timestamp(year=DATA_END.year, month=1, day=1)

# ---------- aggregation helpers ----------
def expand(d):
    """Duplicate rows so each sale also counts in 'All' buckets and at district / Abu Dhabi level."""
    parts = []
    for level, area, proj in [("Abu Dhabi", "Abu Dhabi", None), ("District", "District", None), ("Project", "District", "Project")]:
        x = d.copy()
        x["Level"] = level
        x["Area"] = "Abu Dhabi" if level == "Abu Dhabi" else x["District"]
        x["Project Out"] = x["Project"] if proj else "All projects"
        parts.append(x)
    d = pd.concat(parts)
    d = pd.concat([d, d.assign(**{"Sale Type": "All"})])
    d = pd.concat([d, d.assign(Bedrooms="All")])
    return d

def stats(d, keys):
    a = d.groupby(keys).agg(
        Sales=("Price", "size"),
        Avg_sqft=("AED per sqft", "mean"),
        Med_sqft=("AED per sqft", "median"),
        Avg_price=("Price", "mean"),
        Med_price=("Price", "median"),
        Avg_size=("Size sqft", "mean"),
        First=("Date", "min"),
        Last=("Date", "max"),
    ).reset_index()
    a = a.rename(columns={
        "Avg_sqft": "Avg AED per sqft", "Med_sqft": "Median AED per sqft",
        "Avg_price": "Avg price AED", "Med_price": "Median price AED", "Avg_size": "Avg size sqft",
        "First": "First sale", "Last": "Last sale", "Project Out": "Project",
    })
    for c in ["Avg AED per sqft", "Median AED per sqft", "Avg price AED", "Median price AED", "Avg size sqft"]:
        a[c] = a[c].round(0).astype(int)
    a["First sale"] = a["First sale"].dt.date
    a["Last sale"] = a["Last sale"].dt.date
    a["Reliability"] = np.where(a["Sales"] >= MIN_SALES, "OK", "Low sample")
    return a

dims = ["Level", "Area", "Project Out", "Type", "Bedrooms", "Sale Type"]
x = expand(df)

# ---------- table 1: quarterly ----------
# Quarterly: off-plan/ready split only at Abu Dhabi + district level (keeps the table under 50k rows)
xq = x[(x["Level"] != "Project") | (x["Sale Type"] == "All")]
qt = stats(xq, dims + ["Quarter"])
q_end = pd.PeriodIndex(qt["Quarter"].str.replace("-", ""), freq="Q").end_time
qt["Quarter status"] = np.where(q_end.normalize() <= DATA_END, "Complete", f"Partial (data to {DATA_END.date()})")
qt = qt.sort_values(["Level", "Area", "Project", "Type", "Bedrooms", "Sale Type", "Quarter"])
qt.insert(0, "Key", qt["Level"] + " | " + qt["Area"] + " | " + qt["Project"] + " | " + qt["Type"] + " | "
          + qt["Bedrooms"] + " | " + qt["Sale Type"] + " | " + qt["Quarter"])

# ---------- table 2: calendar year-to-date, rolling periods + ranks ----------
PERIODS = {"This year": "year-to-date", "Last 3 months": 3, "Last 12 months": 12, "Last 2 years": 24, "Last 3 years": 36, "All data": None}
pts = []
for name, months in PERIODS.items():
    if name == "This year":
        # Filter the cleaned sales themselves; quarterly averages cannot be averaged.
        sub = x[x["Date"] >= YEAR_START]
    else:
        sub = x if months is None else x[x["Date"] > DATA_END - pd.DateOffset(months=months)]
    p = stats(sub, dims)
    p.insert(0, "Period", name)
    pts.append(p)
pt = pd.concat(pts)

# Cheapest rank uses average AED/sqft this year; older periods retain median ranks.
# Rank only reliable rows within the same Level + Period + Type + Bedrooms + Sale Type.
grp = ["Period", "Level", "Type", "Bedrooms", "Sale Type"]
ok = pt["Reliability"] == "OK"
pt["Cheapest rank"] = np.nan
pt.loc[ok, "Cheapest rank"] = pt[ok].groupby(grp)["Median AED per sqft"].rank(method="min")
year_ok = ok & pt["Period"].eq("This year")
pt.loc[year_ok, "Cheapest rank"] = pt[year_ok].groupby(grp)["Avg AED per sqft"].rank(method="min")
pt["Cheapest rank"] = pt["Cheapest rank"].astype("Int64")
pt["Data up to"] = DATA_END.date()
pt = pt.sort_values(["Period", "Level", "Area", "Project", "Type", "Bedrooms", "Sale Type"])
pt.insert(0, "Key", pt["Period"] + " | " + pt["Level"] + " | " + pt["Area"] + " | " + pt["Project"] + " | "
          + pt["Type"] + " | " + pt["Bedrooms"] + " | " + pt["Sale Type"])

qt.to_csv("quarterly_prices.csv", index=False)
pt.to_csv("period_prices.csv", index=False)
report += [
    f"Data covers: {df['Date'].min().date()} to {DATA_END.date()}",
    f"This year: {YEAR_START.date()} to {DATA_END.date()}",
    f"Sales used this year: {(df['Date'] >= YEAR_START).sum()}",
    f"This year named projects: {df.loc[(df['Date'] >= YEAR_START) & ~df['Project'].isin(['Private', 'No project name', 'All projects']), 'Project'].nunique()}",
    f"This year districts: {df.loc[df['Date'] >= YEAR_START, 'District'].nunique()}",
    f"This year period rows: {(pt['Period'] == 'This year').sum()}",
    f"quarterly_prices.csv rows: {len(qt)}",
    f"period_prices.csv rows: {len(pt)}",
    "Cheapest rank: This year uses Avg AED per sqft; other periods use Median AED per sqft.",
    "Rules: price per sqft = price / (sqm x 10.7639); full sales only; court-mandated excluded;",
    "extreme values (outside 1st-99th percentile per district+type+bedrooms) excluded;",
    f"rows with fewer than {MIN_SALES} sales marked 'Low sample' and not ranked.",
]
open("build_report.txt", "w").write("\n".join(report) + "\n")
print("\n".join(report))
