import { LightningElement, api, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

import getInitialData from '@salesforce/apex/CandidateSubmissionController.getInitialData';
import saveSubmission from '@salesforce/apex/CandidateSubmissionController.saveSubmission';
// Draft persistence: create/restore draft submission and save state across stages
import getOrCreateDraftSubmission from '@salesforce/apex/CandidateSubmissionController.getOrCreateDraftSubmission';
import saveDraftState from '@salesforce/apex/CandidateSubmissionController.saveDraftState';

export default class CandidateSubmission extends LightningElement {
    _recordId;
    _preSelectedResumeId = null;

    @api objectApiName;
    @api preSelectedResumeName = '';
    @api hideHeader = false;

    @api
    get recordId() {
        return this._recordId;
    }
    set recordId(value) {
        if (value) {
            this._recordId = value;
            this.fetchInitialData();
        }
    }

    @api
    get preSelectedResumeId() {
        return this._preSelectedResumeId;
    }
    set preSelectedResumeId(value) {
        this._preSelectedResumeId = value;
        if (value) {
            this.submissionData = {
                ...this.submissionData,
                documents: {
                    ...this.submissionData.documents,
                    Resume: value
                }
            };
        }
    }

    @track currentStage = null;
    @track stages = [];
    @track isLoading = true;
    @track missingItems = [];
    @track showValidationModal = false;

    @track showAccountManagerModal = false;
    @track selectedAccountManagerId = null;
    @track amPickerError = null;

    @track submissionRecordId = null; // Draft persistence: the Candidate_Submission__c record ID

    @track mergedPdfAttachmentId = null;
    @track isCombineEnabled = true;
    @track individualDocIds = [];

    @track submissionData = {
        candidateId: null,
        jobApplicantId: null,
        accountId: null,
        documents: {
            Resume: null,
            References: null,
            BLS_Card: null,
            ACLS_Card: null,
          
            Credentials: null
        },
        stageStatus: {
            References__c: 'None',
            BLS_Card__c: false,
            ACLS_Card__c: false
          
        }
    };

    // ─── Stage getters ────────────────────────────────────────────────────────

    get isResumeStage()          { return this.currentStage === 'Resume'; }
    get isReferencesStage()      { return this.currentStage === 'References'; }
    get isBlsStage()             { return this.currentStage === 'BLS_Card'; }
    get isAclsStage()            { return this.currentStage === 'ACLS_Card'; }
    get isSkillsChecklistStage() { return this.currentStage === 'Skills_Checklist'; }
    get isCredentialsStage()     { return this.currentStage === 'Credentials'; }
    get isReviewStage()          { return this.currentStage === 'Review'; }

    get tabsStickyClass() {
        return this.hideHeader
            ? 'cs-tabs-sticky cs-tabs-sticky--no-header'
            : 'cs-tabs-sticky';
    }

    get stagesWithMeta() {
        const stageList  = this.stages || [];
        const currentIdx = stageList.findIndex((s) => s.value === this.currentStage);

        return stageList.map((s, idx) => {
            const isPassed  = idx < currentIdx;
            const isActive  = s.value === this.currentStage;

            let isFilled = !!(this.submissionData.documents && this.submissionData.documents[s.value]);
            if (s.value === 'Review') isFilled = false;

            const isSkipped = isPassed && !isFilled && s.value !== 'Review';

            let tabClass  = 'cs-tab';
            let iconClass = 'cs-tab-icon';
            if (isActive) {
                tabClass  += ' cs-tab--active';
                iconClass += ' cs-tab-icon--active';
            } else if (isFilled) {
                tabClass  += ' cs-tab--done';
                iconClass += ' cs-tab-icon--done';
            } else if (isSkipped) {
                tabClass  += ' cs-tab--skipped';
                iconClass += ' cs-tab-icon--skipped';
            }

            return { ...s, isDone: isFilled, isSkipped, isActive, tabClass, iconClass };
        });
    }

    get blsExcludedDocIds()            { return this.getExcludedDocIdsFor('BLS_Card'); }
    get aclsExcludedDocIds()           { return this.getExcludedDocIdsFor('ACLS_Card'); }
   
    get credentialsExcludedDocIds()    { return this.getExcludedDocIdsFor('Credentials'); }

    // ─── Data loading ────────────────────────────────────────────────────────

    fetchInitialData() {
        this.isLoading = true;
        getInitialData({ recordId: this.recordId, objectName: this.objectApiName })
            .then((result) => {
                this.submissionData = {
                    ...this.submissionData,
                    candidateId:    result.candidateId,
                    jobApplicantId: result.jobApplicantId,
                    accountId:      result.accountId
                };

                if (result.submissionStages && result.submissionStages.length > 0) {
                    const newStages = result.submissionStages.map((templateStage) => ({
                        label:      templateStage.label,
                        value:      templateStage.stageKey,
                        stepNum:    templateStage.stageIndex,
                        iconName:   templateStage.iconName,
                        isRequired: templateStage.isRequired,
                        isActive:   templateStage.isActive
                    }));

                    const hasReview = newStages.some((s) => s.value === 'Review');
                    if (!hasReview) {
                        newStages.push({
                            label: 'Review & Submit', value: 'Review',
                            stepNum: newStages.length + 1,
                            iconName: 'utility:upload',
                            isRequired: false, isActive: true
                        });
                    }

                    this.stages = newStages;

                    const docs   = { ...this.submissionData.documents };
                    const status = { ...this.submissionData.stageStatus };

                    newStages.forEach((s) => {
                        if (s.value && s.value !== 'Review') {
                            if (docs[s.value] === undefined) docs[s.value] = null;
                            const statusKey = s.value.endsWith('__c') ? s.value : s.value + '__c';
                            if (status[statusKey] === undefined) {
                                status[statusKey] = s.value.includes('References') ? 'None' : false;
                            }
                        }
                    });

                    this.submissionData = { ...this.submissionData, documents: docs, stageStatus: status };
                    this.currentStage   = this.stages[0].value;
                } else {
                    this.stages = [
                        { label: 'Resume',          value: 'Resume',           stepNum: 1, iconName: 'utility:user',      isRequired: true,  isActive: true },
                        { label: 'References',       value: 'References',       stepNum: 2, iconName: 'utility:people',    isRequired: false, isActive: true },
                        { label: 'BLS Card',         value: 'BLS_Card',         stepNum: 3, iconName: 'utility:note',      isRequired: false, isActive: true },
                        { label: 'ACLS Card',        value: 'ACLS_Card',        stepNum: 4, iconName: 'utility:favorite',  isRequired: false, isActive: true },
                        { label: 'Credentials',      value: 'Credentials',      stepNum: 5, iconName: 'utility:task',      isRequired: false, isActive: true },
                        { label: 'Review & Submit',  value: 'Review',           stepNum: 6, iconName: 'utility:upload',    isRequired: false, isActive: true }
                    ];
                    this.currentStage = 'Resume';
                }

                if (this._preSelectedResumeId) {
                    this.submissionData = {
                        ...this.submissionData,
                        documents: { ...this.submissionData.documents, Resume: this._preSelectedResumeId }
                    };
                }

                // Draft persistence: create or restore a Draft Candidate_Submission__c
                return this._initDraftSubmission();
            })
            .catch((error) => {
                this.showToast('Error', `Failed to load context. ${this.getErrorMessage(error)}`, 'error');
            })
            .finally(() => {
                this.isLoading = false;
            });
    }

    // Draft persistence: get or create the draft submission record,
    // and restore saved state (documents, stage status, last stage) if resuming.
    async _initDraftSubmission() {
        try {
            const draft = await getOrCreateDraftSubmission({
                candidateId:    this.submissionData.candidateId,
                jobApplicantId: this.submissionData.jobApplicantId,
                accountId:      this.submissionData.accountId
            });

            this.submissionRecordId = draft.submissionId;
            console.log('[Draft] submissionRecordId:', this.submissionRecordId, 'isExisting:', draft.isExisting);

            // Restore saved state from an existing draft
            if (draft.isExisting && draft.documentSelectionJson) {
                try {
                    const saved = JSON.parse(draft.documentSelectionJson);

                    if (saved.documents) {
                        this.submissionData = {
                            ...this.submissionData,
                            documents: { ...this.submissionData.documents, ...saved.documents }
                        };
                    }
                    if (saved.stageStatus) {
                        this.submissionData = {
                            ...this.submissionData,
                            stageStatus: { ...this.submissionData.stageStatus, ...saved.stageStatus }
                        };
                    }

                    // Navigate to the last filled stage (not skipping first stage for fresh)
                    if (saved.lastFilledStage) {
                        const stageList = this.stages || [];
                        const targetIdx = stageList.findIndex((s) => s.value === saved.lastFilledStage);
                        if (targetIdx >= 0) {
                            this.currentStage = stageList[targetIdx].value;
                            console.log('[Draft] Restored to stage:', this.currentStage);
                        }
                    }

                    // Restore pre-selected resume
                    if (saved.documents?.Resume) {
                        this._preSelectedResumeId = saved.documents.Resume;
                    }
                } catch (parseErr) {
                    console.warn('[Draft] Failed to parse saved state:', parseErr);
                }
            }
        } catch (err) {
            console.error('[Draft] Failed to create/restore draft:', err);
        }
    }

    // Draft persistence: save current state to the submission record.
    // Called on every document selection change and stage navigation.
    _persistDraftState() {
        if (!this.submissionRecordId) return;

        // Determine the last filled stage
        const stageList = this.stages || [];
        let lastFilledStage = null;
        for (let i = stageList.length - 1; i >= 0; i--) {
            const s = stageList[i];
            if (s.value !== 'Review' && this.submissionData.documents?.[s.value]) {
                lastFilledStage = s.value;
                break;
            }
        }
        // If no stage has a document but we're past Resume, use currentStage
        if (!lastFilledStage && this.currentStage !== 'Resume') {
            lastFilledStage = this.currentStage;
        }

        const stateJson = JSON.stringify({
            documents:       this.submissionData.documents,
            stageStatus:     this.submissionData.stageStatus,
            lastFilledStage: lastFilledStage || this.currentStage
        });

        saveDraftState({ submissionId: this.submissionRecordId, documentSelectionJson: stateJson })
            .catch((err) => console.warn('[Draft] Failed to persist state:', err));
    }

    getExcludedDocIdsFor(stageKey) {
        const d   = this.submissionData.documents || {};
        const ids = [];
        Object.keys(d).forEach((k) => {
            if (k !== stageKey && d[k]) {
                if (Array.isArray(d[k])) ids.push(...d[k]);
                else ids.push(d[k]);
            }
        });
        return ids;
    }

    // ─── Event handlers ───────────────────────────────────────────────────────

    handleResumeSelectionChange(event) {
        const selectedResumeId   = event.detail?.selectedResumeId || null;
        const selectedResumeName = event.detail?.selectedResumeName || '';

        this.submissionData = {
            ...this.submissionData,
            documents: { ...this.submissionData.documents, Resume: selectedResumeId }
        };

        this._preSelectedResumeId = selectedResumeId;
        if (selectedResumeName) this.preSelectedResumeName = selectedResumeName;

        // Draft persistence: save state when resume selection changes
        this._persistDraftState();
    }

    handleFileStageSelectionChange(event) {
        const stageKey           = event.detail?.stageKey;
        const selectedDocumentId = event.detail?.selectedDocumentId || null;
        if (!stageKey) return;

        const nextStageStatus = { ...this.submissionData.stageStatus };
        const statusKey       = stageKey.endsWith('__c') ? stageKey : stageKey + '__c';

        if (stageKey.includes('References')) {
            nextStageStatus[statusKey] = selectedDocumentId ? 'Completed' : 'None';
        } else {
            nextStageStatus[statusKey] = !!selectedDocumentId;
        }

        this.submissionData = {
            ...this.submissionData,
            documents:   { ...this.submissionData.documents, [stageKey]: selectedDocumentId },
            stageStatus: nextStageStatus
        };

        // Draft persistence: save state when any stage selection changes
        this._persistDraftState();
    }

    handleReviewMergedChange(event) {
        this.mergedPdfAttachmentId = event.detail?.mergedPdfAttachmentId || null;
        this.isCombineEnabled      = event.detail?.isCombineEnabled !== false;
        // FIX: always store individualDocIds from the event, regardless of isCombineEnabled
        // The review component now always sends them
        this.individualDocIds      = event.detail?.individualDocIds || [];

        console.log('[Parent] handleReviewMergedChange — isCombineEnabled:', this.isCombineEnabled);
        console.log('[Parent] handleReviewMergedChange — individualDocIds:', JSON.stringify(this.individualDocIds));
        console.log('[Parent] handleReviewMergedChange — mergedPdfAttachmentId:', this.mergedPdfAttachmentId);
    }

    handleStageDocumentsRefresh() {
        // Stage components own their own data reload
    }

    // ─── Navigation ──────────────────────────────────────────────────────────

    async handleNext() {
        const stageList = this.stages || [];
        const idx       = stageList.findIndex((s) => s.value === this.currentStage);

        if (this.currentStage === 'Resume') {
            const resumeCmp = this.template.querySelector('c-candidate-submission-stage-resume');
            if (resumeCmp && typeof resumeCmp.validateAndSave === 'function') {
                this.isLoading    = true;
                const isValid     = await resumeCmp.validateAndSave();
                this.isLoading    = false;
                if (!isValid) return;
            }
        }

        if (idx >= 0) {
            const currentStageObj = stageList[idx];
            if (currentStageObj.isRequired) {
                const isFilled = !!this.submissionData.documents[currentStageObj.value];
                if (!isFilled) {
                    this.showToast('Required Stage', `${currentStageObj.label} is required.`, 'warning');
                    return;
                }
            }
        }

        if (idx < stageList.length - 1) {
            this.currentStage = stageList[idx + 1].value;
            this.scrollToStageTop();
            // Draft persistence: save current stage on navigation
            this._persistDraftState();
        }
    }

    handlePrevious() {
        const stageList = this.stages || [];
        const idx       = stageList.findIndex((s) => s.value === this.currentStage);
        if (idx > 0) {
            this.currentStage = stageList[idx - 1].value;
            this.scrollToStageTop();
        }
    }

    handleStageSelect(event) {
        this.currentStage = event.currentTarget.dataset.value;
        this.scrollToStageTop();
    }

    scrollToStageTop() {
        requestAnimationFrame(() => {
            const card = this.template.querySelector('.cs-card');
            if (card) {
                const top = card.getBoundingClientRect().top + window.pageYOffset - 8;
                window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
                return;
            }
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    // ─── Submit flow ─────────────────────────────────────────────────────────

    async handlePreSubmitCheck() {
        const reviewCmp = this.template.querySelector('c-candidate-submission-stage-review');

        if (reviewCmp) {
            // Validate first
            const validation = await reviewCmp.validateForSubmit();
            if (!validation?.ok) {
                this.showToast('PDF Required', validation?.errorMessage || 'Please use only PDF files.', 'error');
                return;
            }

            // Pull the freshest state right now, before opening any modal.
            if (typeof reviewCmp.getMergedChangeDetail === 'function') {
                const latest = reviewCmp.getMergedChangeDetail();
                this.mergedPdfAttachmentId = latest.mergedPdfAttachmentId;
                this.isCombineEnabled      = latest.isCombineEnabled;
                // FIX: always capture individualDocIds — review component always sends them now
                this.individualDocIds      = latest.individualDocIds || [];

                console.log('[Parent] handlePreSubmitCheck — refreshed from getMergedChangeDetail');
                console.log('[Parent] handlePreSubmitCheck — isCombineEnabled:', this.isCombineEnabled);
                console.log('[Parent] handlePreSubmitCheck — individualDocIds:', JSON.stringify(this.individualDocIds));
            }
        }

        const d       = this.submissionData.documents;
        const missing = [];
        this.stages.forEach((s) => {
            if (s.isRequired && s.value !== 'Review' && !d[s.value]) {
                missing.push(s.label);
            }
        });

        if (missing.length > 0) {
            this.missingItems        = missing;
            this.showValidationModal = true;
        } else {
            this.showAccountManagerModal = true;
        }
    }

    closeValidationModal() {
        this.showValidationModal = false;
    }

    handleProceedSubmit() {
        this.showValidationModal     = false;
        this.showAccountManagerModal = true;
    }

    closeAccountManagerModal() {
        this.showAccountManagerModal  = false;
        this.selectedAccountManagerId = null;
        this.amPickerError            = null;
    }

    handleAccountManagerChange(event) {
        this.selectedAccountManagerId = event.detail.recordId;
        this.amPickerError            = null;
    }

    async executeSubmit() {
        if (!this.selectedAccountManagerId) {
            this.amPickerError = 'Please select an Account Manager.';
            return;
        }

        // Re-read from review component one final time at the moment of save.
        const reviewCmp = this.template.querySelector('c-candidate-submission-stage-review');
        if (reviewCmp && typeof reviewCmp.getMergedChangeDetail === 'function') {
            const latest = reviewCmp.getMergedChangeDetail();
            this.mergedPdfAttachmentId = latest.mergedPdfAttachmentId;
            this.isCombineEnabled      = latest.isCombineEnabled;
            // FIX: always capture individualDocIds
            this.individualDocIds      = latest.individualDocIds || [];

            console.log('[Parent] executeSubmit — refreshed from getMergedChangeDetail');
            console.log('[Parent] executeSubmit — isCombineEnabled:', this.isCombineEnabled);
            console.log('[Parent] executeSubmit — individualDocIds:', JSON.stringify(this.individualDocIds));
        }

        // SAFETY NET: if individualDocIds is still empty for any reason,
        // build from the documents map directly as a last resort
        if (!this.individualDocIds || this.individualDocIds.length === 0) {
            const d = this.submissionData.documents || {};
            this.individualDocIds = [
                d.Resume, d.References, d.BLS_Card, d.ACLS_Card, d.Credentials
            ].filter(Boolean);
            console.log('[Parent] executeSubmit — safety net individualDocIds:', JSON.stringify(this.individualDocIds));
        }

        this.isLoading = true;
        try {
            const dataToSave = {
                ...this.submissionData,
                submissionId:       this.submissionRecordId, // Draft persistence: pass existing Draft record
                accountManagerId:   this.selectedAccountManagerId,
                mergedAttachmentId: this.isCombineEnabled ? this.mergedPdfAttachmentId : null,
                isCombineEnabled:   this.isCombineEnabled,
                individualDocIds:   this.isCombineEnabled ? [] : this.individualDocIds
            };

            console.log('[Parent] executeSubmit — dataToSave.isCombineEnabled:', dataToSave.isCombineEnabled);
            console.log('[Parent] executeSubmit — dataToSave.individualDocIds:', JSON.stringify(dataToSave.individualDocIds));
            console.log('[Parent] executeSubmit — dataToSave.mergedAttachmentId:', dataToSave.mergedAttachmentId);

            const resultId = await saveSubmission({
                submissionDataJSON: JSON.stringify(dataToSave)
            });

            this.showToast('Success', 'Candidate submitted successfully!', 'success');
            setTimeout(() => {
                window.location.href = '/' + resultId;
            }, 500);
        } catch (err) {
            this.showToast('Error', `Submission failed: ${this.getErrorMessage(err)}`, 'error');
        } finally {
            this.isLoading = false;
        }
    }

    // ─── Utilities ───────────────────────────────────────────────────────────

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }

    getErrorMessage(error) {
        if (Array.isArray(error?.body))              return error.body.map((e) => e.message).join(', ');
        if (typeof error?.body?.message === 'string') return error.body.message;
        if (typeof error?.message === 'string')       return error.message;
        return 'Unknown error';
    }
}