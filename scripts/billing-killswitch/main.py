"""Billing kill switch: budget Pub/Sub messages arrive here; once actual cost
crosses the budget amount, detach billing from the project. Everything on GCP
stops accruing cost (Cloud Run goes offline); re-arm by relinking billing.
"""
import base64, json, os
import functions_framework
from googleapiclient import discovery

PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "")

@functions_framework.cloud_event
def stop_billing(cloud_event):
    payload = json.loads(base64.b64decode(cloud_event.data["message"]["data"]).decode())
    cost, budget = payload.get("costAmount", 0), payload.get("budgetAmount", 0)
    if cost <= budget:
        print(f"cost {cost} <= budget {budget}: no action")
        return
    name = f"projects/{PROJECT_ID}"
    billing = discovery.build("cloudbilling", "v1", cache_discovery=False)
    info = billing.projects().getBillingInfo(name=name).execute()
    if not info.get("billingEnabled"):
        print("billing already disabled")
        return
    billing.projects().updateBillingInfo(name=name, body={"billingAccountName": ""}).execute()
    print(f"KILL SWITCH TRIPPED: billing detached at cost {cost} (budget {budget})")
