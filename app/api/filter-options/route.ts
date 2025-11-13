import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// Helper function to extract filter values from coatings
function extractFilterOptions(coatings: any[]) {
  const families = new Set<string>()
  const productTypes = new Set<string>()
  const productModels = new Set<string>()

  coatings?.forEach((coating: any) => {
    // Extract family
    const familyValue = coating.family || coating.Family || coating.product_family || coating.productFamily
    if (familyValue && String(familyValue).trim()) {
      families.add(String(familyValue).trim())
    }

    // Extract product type
    const typeValue = coating.product_type || coating.productType || coating.type || coating.Type || coating.category || coating.Category
    if (typeValue && String(typeValue).trim()) {
      productTypes.add(String(typeValue).trim())
    }

    // Extract product model
    const modelValue = coating.product_model || coating.productModel || coating.model || coating.Model
    if (modelValue && String(modelValue).trim()) {
      productModels.add(String(modelValue).trim())
    }

    // Also check in all_attributes
    if (coating.all_attributes) {
      try {
        let attributes: any = typeof coating.all_attributes === 'string' 
          ? JSON.parse(coating.all_attributes) 
          : coating.all_attributes

        const attrFamily = attributes.family || attributes.Family || attributes.product_family || attributes.productFamily
        if (attrFamily && String(attrFamily).trim()) {
          families.add(String(attrFamily).trim())
        }

        const attrType = attributes.product_type || attributes.productType || attributes.type || attributes.Type
        if (attrType && String(attrType).trim()) {
          productTypes.add(String(attrType).trim())
        }

        const attrModel = attributes.product_model || attributes.productModel || attributes.model || attributes.Model
        if (attrModel && String(attrModel).trim()) {
          productModels.add(String(attrModel).trim())
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }
  })

  return {
    families: Array.from(families).sort(),
    productTypes: Array.from(productTypes).sort(),
    productModels: Array.from(productModels).sort()
  }
}

// Helper to get field value from coating
function getFieldValue(coating: any, fieldType: 'family' | 'type' | 'model'): string | null {
  let value = null

  if (fieldType === 'family') {
    value = coating.family || coating.Family || coating.product_family || coating.productFamily
    if (!value && coating.all_attributes) {
      const attr = typeof coating.all_attributes === 'string' ? JSON.parse(coating.all_attributes) : coating.all_attributes
      value = attr?.family || attr?.Family || attr?.product_family || attr?.productFamily
    }
  } else if (fieldType === 'type') {
    value = coating.product_type || coating.productType || coating.type || coating.Type || coating.category || coating.Category
    if (!value && coating.all_attributes) {
      const attr = typeof coating.all_attributes === 'string' ? JSON.parse(coating.all_attributes) : coating.all_attributes
      value = attr?.product_type || attr?.productType || attr?.type || attr?.Type
    }
  } else if (fieldType === 'model') {
    value = coating.product_model || coating.productModel || coating.model || coating.Model
    if (!value && coating.all_attributes) {
      const attr = typeof coating.all_attributes === 'string' ? JSON.parse(coating.all_attributes) : coating.all_attributes
      value = attr?.product_model || attr?.productModel || attr?.model || attr?.Model
    }
  }

  return value ? String(value).trim() : null
}

// Smart filtering: only filter by the fields that are selected
function filterCoatings(coatings: any[], filters: any) {
  if (!filters || (!filters.family && !filters.productType && !filters.productModel)) {
    return coatings
  }

  return coatings.filter(coating => {
    let matches = true

    // Check family if selected
    if (filters.family) {
      const familyValue = getFieldValue(coating, 'family')
      if (familyValue !== filters.family) {
        matches = false
      }
    }

    // Check product type if selected
    if (filters.productType) {
      const typeValue = getFieldValue(coating, 'type')
      if (typeValue !== filters.productType) {
        matches = false
      }
    }

    // Check product model if selected
    if (filters.productModel) {
      const modelValue = getFieldValue(coating, 'model')
      if (modelValue !== filters.productModel) {
        matches = false
      }
    }

    return matches
  })
}

// POST handler - with dynamic filtering based on current selections
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { currentFilters } = body

    console.log('📋 Loading filter options with current filters:', currentFilters)

    // Fetch all coatings
    const { data: coatings, error } = await supabase
      .from('coatings')
      .select('*')
      .limit(10000)

    if (error) {
      throw new Error(`Database error: ${error.message}`)
    }

    console.log(`📦 Fetched ${coatings?.length || 0} total coatings`)

    // Apply filters to get relevant subset
    const filteredCoatings = filterCoatings(coatings || [], currentFilters)
    
    console.log(`🔍 After filtering: ${filteredCoatings.length} coatings match criteria`)

    // Extract filter options from filtered data
    const { families, productTypes, productModels } = extractFilterOptions(filteredCoatings)

    console.log(`✅ Available options:`, {
      families: families.length,
      productTypes: productTypes.length,
      productModels: productModels.length
    })

    // Debug: log first few values
    console.log('Sample families:', families.slice(0, 5))
    console.log('Sample types:', productTypes.slice(0, 5))
    console.log('Sample models:', productModels.slice(0, 5))

    return NextResponse.json({
      success: true,
      families,
      productTypes,
      productModels,
      totalCoatings: filteredCoatings.length
    })

  } catch (error: any) {
    console.error('❌ Filter options error:', error)
    
    return NextResponse.json(
      { 
        success: false,
        error: error.message || 'Failed to load filter options',
        families: [],
        productTypes: [],
        productModels: [],
        totalCoatings: 0
      },
      { status: 500 }
    )
  }
}

// GET handler - initial load without filters
export async function GET() {
  try {
    console.log('📋 Loading initial filter options...')

    const { data: coatings, error } = await supabase
      .from('coatings')
      .select('*')
      .limit(10000)

    if (error) {
      throw new Error(`Database error: ${error.message}`)
    }

    console.log(`📦 Fetched ${coatings?.length || 0} coatings`)

    // Extract filter options
    const { families, productTypes, productModels } = extractFilterOptions(coatings || [])

    console.log(`✅ Initial options:`, {
      families: families.length,
      productTypes: productTypes.length,
      productModels: productModels.length
    })

    return NextResponse.json({
      success: true,
      families,
      productTypes,
      productModels,
      totalCoatings: coatings?.length || 0
    })

  } catch (error: any) {
    console.error('❌ Filter options error:', error)
    
    return NextResponse.json(
      { 
        success: false,
        error: error.message || 'Failed to load filter options',
        families: [],
        productTypes: [],
        productModels: [],
        totalCoatings: 0
      },
      { status: 500 }
    )
  }
}
