import { LightningElement, api, track, wire } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getSubmissionTemplate from '@salesforce/apex/SubmissionTemplateController.getSubmissionTemplate';
import saveSubmissionTemplate from '@salesforce/apex/SubmissionTemplateController.saveSubmissionTemplate';

const ALL_STAGES = [
    { key: 'Resume',          label: 'Resume' },
    { key: 'References',      label: 'References' },
    { key: 'BLS_Card',        label: 'BLS Card' },
    { key: 'ACLS_Card',       label: 'ACLS Card' },
    { key: 'Skills_Checklist',label: 'Skills Checklist' },
    { key: 'Credentials',     label: 'Credentials' }
];

export default class JobSubmissionTemplate extends LightningElement {
    @api recordId; // Job record Id

    @track stageData = [];
    @track isLoading = true;
    @track isSaving = false;
    @track isDirty = false;

    _originalData = [];

    connectedCallback() {
        this.loadTemplate();
    }

    async loadTemplate() {
        this.isLoading = true;
        try {
            const result = await getSubmissionTemplate({ jobId: this.recordId });
            this.initStages(result);
        } catch (error) {
            this.showToast('Error', this.getErrorMessage(error), 'error');
        } finally {
            this.isLoading = false;
        }
    }

    initStages(savedStages) {
        // savedStages is a list of wrapper objects from Apex:
        // { stageKey, index, isRequired, isActive }
        const savedMap = {};
        (savedStages || []).forEach(s => { savedMap[s.stageKey] = s; });

        this.stageData = ALL_STAGES.map((stage, i) => {
            const saved = savedMap[stage.key];
            return {
                key: stage.key,
                label: stage.label,
                index: saved ? saved.stageIndex : (i + 1),
                isRequired: saved ? saved.isRequired : false,
                isActive: saved ? saved.isActive : false
            };
        });

        // Sort by saved index
        this.stageData.sort((a, b) => a.index - b.index);
        this.reindex();
        this._originalData = JSON.stringify(this.stageData);
        this.isDirty = false;
    }

    reindex() {
        this.stageData = this.stageData.map((s, i) => ({ ...s, index: i + 1 }));
    }

    get stages() {
        const total = this.stageData.length;
        return this.stageData.map((s, i) => {
            const isActive = s.isActive;
            const isRequired = s.isRequired;
            let badgeClass = 'st-badge ';
            let badgeLabel = '';
            if (isActive && isRequired) {
                badgeClass += 'st-badge--active-required';
                badgeLabel = 'Active · Required';
            } else if (isActive && !isRequired) {
                badgeClass += 'st-badge--active-optional';
                badgeLabel = 'Active · Optional';
            } else {
                badgeClass += 'st-badge--inactive';
                badgeLabel = 'Inactive';
            }
            return {
                ...s,
                isFirst: i === 0,
                isLast: i === total - 1,
                rowClass: isActive ? 'st-stage-row st-stage-row--active' : 'st-stage-row st-stage-row--inactive',
                requiredToggleClass: isRequired ? 'st-toggle st-toggle--on' : 'st-toggle',
                activeToggleClass: isActive ? 'st-toggle st-toggle--on' : 'st-toggle',
                requiredLabel: isRequired ? 'Yes' : 'No',
                activeLabel: isActive ? 'On' : 'Off',
                isRequiredStr: String(isRequired),
                isActiveStr: String(isActive),
                badgeClass,
                badgeLabel
            };
        });
    }

    get activeCount() {
        return this.stageData.filter(s => s.isActive).length;
    }

    get requiredCount() {
        return this.stageData.filter(s => s.isRequired).length;
    }

    get totalCount() {
        return this.stageData.length;
    }

    handleToggle(event) {
        const key = event.currentTarget.dataset.key;
        const field = event.currentTarget.dataset.field; // 'isRequired' or 'isActive'
        this.stageData = this.stageData.map(s => {
            if (s.key === key) {
                const updated = { ...s, [field]: !s[field] };
                // If activating, keep as-is. If deactivating, also turn off required
                if (field === 'isActive' && !updated.isActive) {
                    updated.isRequired = false;
                }
                return updated;
            }
            return s;
        });
        this.markDirty();
    }

    handleMoveStage(event) {
        event.stopPropagation();
        const key = event.currentTarget.dataset.key;
        const dir = event.currentTarget.dataset.dir; // 'up' or 'down'
        const idx = this.stageData.findIndex(s => s.key === key);
        if (idx === -1) return;
        const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= this.stageData.length) return;

        const newData = [...this.stageData];
        [newData[idx], newData[swapIdx]] = [newData[swapIdx], newData[idx]];
        this.stageData = newData;
        this.reindex();
        this.markDirty();
    }

    handleReset() {
        this.stageData = JSON.parse(this._originalData);
        this.isDirty = false;
    }

    async handleSave() {
        this.isSaving = true;
        try {
            const payload = this.stageData.map(s => ({
                stageKey: s.key,
                stageIndex: s.index,
                isRequired: s.isRequired,
                isActive: s.isActive
            }));
            await saveSubmissionTemplate({
                jobId: this.recordId,
                stagesJson: JSON.stringify(payload)
            });
            this._originalData = JSON.stringify(this.stageData);
            this.isDirty = false;
            this.showToast('Success', 'Submission template saved successfully.', 'success');
        } catch (error) {
            this.showToast('Error', this.getErrorMessage(error), 'error');
        } finally {
            this.isSaving = false;
        }
    }

    markDirty() {
        this.isDirty = JSON.stringify(this.stageData) !== this._originalData;
    }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }

    getErrorMessage(error) {
        if (Array.isArray(error?.body)) return error.body.map(e => e.message).join(', ');
        if (typeof error?.body?.message === 'string') return error.body.message;
        if (typeof error?.message === 'string') return error.message;
        return 'Unknown error';
    }
}