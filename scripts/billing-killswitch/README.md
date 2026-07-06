# Billing kill switch

A hard spend cap for the GCP project: a Cloud Billing **budget** publishes
spend updates to Pub/Sub; this function listens and, the moment actual cost
exceeds the budget amount, **detaches billing from the project**. Everything
on GCP stops accruing cost (Cloud Run goes offline); external pieces — Neon
(DB) and Cloudflare Pages (web) — are unaffected.

Budget alerts alone are emails, not cutoffs — this is the only way to get an
actual cap on GCP.

## Set up (one time)

```bash
PROJECT=<project-id>                 # e.g. whensdays
BILLING=<billing-account-id>         # gcloud billing accounts list
NUM=$(gcloud projects describe $PROJECT --format="value(projectNumber)")

gcloud services enable billingbudgets.googleapis.com pubsub.googleapis.com \
  cloudfunctions.googleapis.com cloudbuild.googleapis.com eventarc.googleapis.com \
  run.googleapis.com artifactregistry.googleapis.com cloudbilling.googleapis.com \
  --project=$PROJECT

gcloud pubsub topics create billing-killswitch --project=$PROJECT

gcloud billing budgets create --billing-account=$BILLING \
  --display-name="cap (kill switch at 100%)" --budget-amount=25USD \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
  --filter-projects=projects/$NUM \
  --notifications-rule-pubsub-topic=projects/$PROJECT/topics/billing-killswitch

gcloud functions deploy billing-killswitch --project=$PROJECT --region=us-central1 \
  --runtime=python312 --entry-point=stop_billing --trigger-topic=billing-killswitch \
  --set-env-vars=GCP_PROJECT_ID=$PROJECT --memory=256Mi --max-instances=1 --quiet

# Least privilege: manage billing LINKAGE on this one project only.
gcloud projects add-iam-policy-binding $PROJECT \
  --member=serviceAccount:$NUM-compute@developer.gserviceaccount.com \
  --role=roles/billing.projectManager --condition=None
```

## Verify (safe)

Publish an UNDER-budget message and check the log says "no action". Never
publish an over-budget test message — it would really detach billing.

```bash
gcloud pubsub topics publish billing-killswitch --project=$PROJECT \
  --message='{"costAmount": 1.23, "budgetAmount": 25.0}'
gcloud functions logs read billing-killswitch --project=$PROJECT --region=us-central1 --limit=3
```

## When it trips

Billing detaches; Cloud Run stops serving. Re-arm deliberately:

```bash
gcloud billing projects link $PROJECT --billing-account=$BILLING
# then re-run the deploy workflow (or `gcloud run services update`) to restore the API
```

Caveat: billing export lags by hours, so a violent spike can overshoot the cap
somewhat before the data catches up. Pair with `--max-instances` on the Cloud
Run service so a spike physically can't scale unbounded.
